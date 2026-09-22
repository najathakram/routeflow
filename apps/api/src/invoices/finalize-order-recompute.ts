import { roundMoney } from "@routeflow/pricing";
import { effectiveTaxRateFromTotals } from "../common/tax-rate";

export interface OrderRecomputeTotals {
  orderId: string;
  subtotal: number;
  tax: number;
  total: number;
  shippingFee: number;
}

/**
 * B667 (#1185 review, finding 1): decide full coverage BEFORE any line is rewritten. A line
 * billed for only PART of its qty is still "matched" in byTarget, so checking matched-vs-not
 * AFTER the caller's update loop runs let a partially-billed line's own qty get silently shrunk
 * to whatever is currently billed (order qty 10, bill 6 -> row becomes qty 6). A line not
 * matched at all is judged by invoicedQty (finding 2): 0 means never billed, still legitimately
 * pending, and blocks coverage; >0 means it WAS billed and has since been removed from every
 * invoice — a genuine orphan-cancel candidate, not a blocker.
 *
 * When not fully covered, still runs the shipping-fee back-sync (finding 3) — Order.shippingFee
 * is DEFINED as Σ(non-void invoice fees), a property of the invoices alone, so a shipping edit
 * on a partial invoice must still reach the order even while the rest stays gated. `total`
 * shifts by exactly the fee's own delta so it stays consistent without re-deriving the
 * (still-gated) subtotal/tax. Returns the order's totals UNCHANGED otherwise (finding 4).
 *
 * Also syncs every active line's invoicedQty on this partial branch (#1185 review round 3,
 * HIGH+MED) — see the inline comment above that loop for why: it's the only fix for both an
 * invoice qty edit going stale while still partial, and a removed line's invoicedQty never
 * releasing while a SIBLING line keeps the order from full coverage.
 */
export async function checkOrderCoverage(params: {
  db: any;
  orderId: string;
  order: {
    subtotal: unknown;
    tax: unknown;
    total: unknown;
    shippingFee: unknown;
    lineItems: any[];
  };
  byTarget: Map<string, { qty: number }>;
  invoices: any[];
}): Promise<{ fullyCovered: true } | { fullyCovered: false; totals: OrderRecomputeTotals }> {
  const { db, orderId, order, byTarget, invoices } = params;
  const activeLines = (order.lineItems as any[]).filter((li) => li.status !== "CANCELLED");
  const fullyCovered = activeLines.every((li) => {
    const agg = byTarget.get(`line:${li.id}`);
    if (agg) return agg.qty >= Number(li.qty);
    return Number(li.invoicedQty ?? 0) > 0;
  });
  if (fullyCovered) return { fullyCovered: true };

  // B667 (#1185 review round 3, HIGH+MED): the full-coverage path below is the only place that
  // ever wrote OrderItem.invoicedQty, so while the order stays partially covered — this branch —
  // an invoice-item edit never reached it and invoicedQty could go stale in EITHER direction: an
  // up-edit under-counted what's now billed (order qty 10, invoice edited 4 -> 6, invoicedQty
  // stuck at 4 -> a later invoice can still bill 6 more, 12 against 10); a down-edit or removal
  // over-counted it (a billed-then-removed line keeps a non-zero invoicedQty forever and can
  // never be invoiced again, even though it lost every invoice covering it). Sync every active
  // line's invoicedQty to what its invoices bill RIGHT NOW — clamped to the line's own qty, 0
  // when unmatched — independent of the heavier full-coverage rewrite (subtotal, boxes/pieces,
  // status) below, which still only runs once every line is covered.
  for (const li of activeLines) {
    const agg = byTarget.get(`line:${li.id}`);
    const billedQty = agg ? Math.min(Number(li.qty), agg.qty) : 0;
    if (Number(li.invoicedQty ?? 0) !== billedQty) {
      await db.orderItem.update({ where: { id: li.id }, data: { invoicedQty: billedQty } });
    }
  }

  const shippingFeeSum = roundMoney(
    invoices.reduce((s: number, inv: any) => s + Number(inv.shippingFee ?? 0), 0),
  );
  const prevShippingFee = Number(order.shippingFee) || 0;
  const orderTotal = roundMoney((Number(order.total) || 0) - prevShippingFee + shippingFeeSum);
  if (shippingFeeSum !== prevShippingFee) {
    await db.order.update({
      where: { id: orderId },
      data: { shippingFee: shippingFeeSum, total: orderTotal },
    });
  }
  return {
    fullyCovered: false,
    totals: {
      orderId,
      subtotal: Number(order.subtotal) || 0,
      tax: Number(order.tax) || 0,
      total: orderTotal,
      shippingFee: shippingFeeSum,
    },
  };
}

/**
 * B667 — the tail of `recomputeOrderFromInvoices`: cancel orphan order lines and rewrite the
 * order's totals to the sum of what its invoices bill. The CALLER decides whether it is safe to
 * be here at all — this only ever runs once every active order line is billed to its full qty
 * (the "wholly invoiced" precondition `resyncOrderInvoicesForEdit` documents, reused not
 * invented; see `invoices.service.ts`'s `fullyCovered` check, computed BEFORE any line's own
 * qty/subtotal gets rewritten — a line billed for only PART of its qty is still "matched", so
 * deciding coverage from byTarget membership alone, after lines are already rewritten, let a
 * partially-billed line's row get silently shrunk to whatever is currently billed. #1185 review).
 *
 * ORPHAN DEFINITION (#1185 review, finding 2): among the lines no live invoice resolved to,
 * `invoicedQty > 0` means this line WAS billed and has since been removed from every invoice —
 * a genuine orphan, cancel it (this is the mechanism's original purpose: an invoice-side removal
 * back-syncing onto the order). `invoicedQty === 0` means never billed at all — it must never
 * reach here while still active (the caller's fullyCovered gate excludes it), but an
 * already-CANCELLED line with stale non-zero qty/subtotal (a prior return, a prior recompute)
 * still gets its numbers normalized to zero.
 */
export async function finalizeOrderRecompute(params: {
  db: any;
  orderId: string;
  order: { subtotal: unknown; tax: unknown };
  /** Order lines no invoice line resolved to (the caller's existing-line loop already removed
   *  every line it matched). */
  unbilled: Map<string, { id: string; status?: string; invoicedQty?: unknown }>;
  subtotal: number;
  categoryTaxSum: number;
  invoices: any[];
}): Promise<OrderRecomputeTotals> {
  const { db, orderId, order, unbilled, categoryTaxSum, invoices } = params;

  // Cancel a genuine orphan (was billed, now removed) and normalize an already-cancelled line's
  // stale qty/subtotal. A line that was NEVER billed (invoicedQty 0) and isn't already cancelled
  // is left untouched — it should not appear here at all while the caller's gate holds.
  for (const orphan of unbilled.values()) {
    const wasBilled = Number(orphan.invoicedQty ?? 0) > 0;
    const alreadyCancelled = orphan.status === "CANCELLED";
    if (!wasBilled && !alreadyCancelled) continue;
    await db.orderItem.update({
      where: { id: orphan.id },
      data: { status: "CANCELLED", qty: 0, subtotal: 0, boxes: null, pieces: null, invoicedQty: 0 },
    });
  }

  // Preserve the order's effective tax rate (avoids depending on global config drift); mirror
  // updateOrderItems' total = subtotal + regular tax + category tax.
  const subtotal = roundMoney(params.subtotal);
  const prevSubtotal = Number(order.subtotal) || 0;
  // B294 round 2: same semantics as the inline `prevSubtotal > 0 ? tax/prevSubtotal : 0` this
  // replaced — the shared helper's zero-subtotal guard lands on the same 0.
  const effectiveTaxRate = effectiveTaxRateFromTotals(order.tax, prevSubtotal, false);
  const tax = roundMoney(subtotal * effectiveTaxRate);
  // RF-4: fold the billed category tax (Σ per line) back into the order total, so the order
  // stays in step with what the invoices actually charged.
  const categoryTax = roundMoney(categoryTaxSum);
  // Shipping back-sync: the order's fee is DEFINED as Σ(non-void invoice fees) — an invoice-side
  // fee edit lands here and updates the order, which is what lets the order-driven reconciles
  // treat the order as source of truth.
  const shippingFeeSum = roundMoney(
    invoices.reduce((s: number, inv: any) => s + Number(inv.shippingFee ?? 0), 0),
  );
  const total = roundMoney(subtotal + tax + categoryTax + shippingFeeSum);
  await db.order.update({
    where: { id: orderId },
    data: { subtotal, tax, total, shippingFee: shippingFeeSum },
  });
  return { orderId, subtotal, tax, total, shippingFee: shippingFeeSum };
}
