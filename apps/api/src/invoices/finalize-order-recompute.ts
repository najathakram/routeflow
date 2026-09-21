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
 * B667 — the tail of `recomputeOrderFromInvoices`: cancel orphan (never-billed) order lines and
 * rewrite the order's totals to the sum of what its invoices bill. That is only correct when the
 * invoices being read COVER THE WHOLE ORDER — the same "wholly invoiced" precondition
 * `resyncOrderInvoicesForEdit` documents (never partially invoiced: not a line billed for only
 * part of its qty, and not a subset of lines billed at full qty while others are un-invoiced).
 *
 * A genuinely partial invoice (`createPartialFromOrder`, then any DRAFT edit on it — a discount,
 * shipping, anything) used to run this tail anyway: it cancelled the not-yet-invoiced line
 * (qty/subtotal forced to 0, though it was never actually sold-and-refused, just not billed
 * YET) and overwrote the order subtotal to only the billed sum, discarding the unbilled line's
 * contribution. Now it leaves both the line and the order totals untouched until the order is
 * genuinely fully covered — the next recompute after the rest is billed applies them then.
 */
export async function finalizeOrderRecompute(params: {
  db: any;
  orderId: string;
  order: { subtotal: unknown; tax: unknown; total: unknown; shippingFee: unknown };
  /** Order lines no invoice line resolved to (the caller's existing-line loop already removed
   *  every line it matched, so whatever remains here was never billed at all). */
  unbilled: Map<string, { id: string; status?: string }>;
  subtotal: number;
  categoryTaxSum: number;
  invoices: any[];
}): Promise<OrderRecomputeTotals> {
  const { db, orderId, order, unbilled, categoryTaxSum, invoices } = params;

  // Fully covered = nothing ACTIVE is left un-billed. A line an invoice never touched but that
  // is already CANCELLED (a prior return, a prior recompute) needs no coverage — only a line
  // still PENDING/etc. and un-billed blocks the order-wide rewrite below.
  const fullyCovered = [...unbilled.values()].every((li) => li.status === "CANCELLED");
  if (!fullyCovered) {
    return {
      orderId,
      subtotal: Number(order.subtotal) || 0,
      tax: Number(order.tax) || 0,
      total: Number(order.total) || 0,
      shippingFee: Number(order.shippingFee) || 0,
    };
  }

  // Order lines billed by no invoice → cancel (they weren't actually sold).
  for (const orphan of unbilled.values()) {
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
