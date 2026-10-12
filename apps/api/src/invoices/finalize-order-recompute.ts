import { ServiceUnavailableException } from "@nestjs/common";
import { holdsValues } from "./order-backsync-lines";
import { Prisma } from "@prisma/client";
import { roundMoney, sumInvoiceTotals } from "@routeflow/pricing";
import { effectiveTaxRateFromTotals } from "../common/tax-rate";
import { withAdvisoryLock, LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import { QTY_EPSILON } from "../orders/merge-idempotency";
import { billableQtyFromBasis, type DeliveredBasis } from "./delivered-basis-by-line";
import { API_ERROR_CODES } from "../common/api-error-codes";

export interface OrderRecomputeTotals {
  orderId: string;
  subtotal: number;
  tax: number;
  total: number;
  shippingFee: number;
}

/**
 * #1185 review round 4 (refined round 5, item 2): a product-only (no orderItemId) invoice item
 * resolves to an order line only when EXACTLY ONE active (non-cancelled) line shares that
 * product — round 4's own "first match" fix was itself ambiguous the moment a SECOND active line
 * shared a product: it silently picked one, crediting that line's billed qty onto its unrelated
 * active sibling and releasing the other (a double-bill door). Group active lines by product;
 * a singleton resolves normally, everything else is unresolvable — `ambiguousLineIds` names
 * every line sharing an ambiguous product, so `checkOrderCoverage`'s sync loop can skip them
 * entirely (bail rather than guess, `resyncOrderInvoicesForEdit`'s own principle, at the
 * per-line grain this partial branch needs rather than that method's whole-order bail).
 */
export function resolveProductMatches(lineItems: any[]): {
  existingByProduct: Map<string, any>;
  ambiguousLineIds: Set<string>;
} {
  const activeByProduct = new Map<string, any[]>();
  for (const li of lineItems) {
    if (li.productId && li.status !== "CANCELLED") {
      const list = activeByProduct.get(li.productId);
      if (list) list.push(li);
      else activeByProduct.set(li.productId, [li]);
    }
  }
  const existingByProduct = new Map<string, any>();
  const ambiguousLineIds = new Set<string>();
  for (const [productId, lines] of activeByProduct) {
    if (lines.length === 1) existingByProduct.set(productId, lines[0]);
    else for (const li of lines) ambiguousLineIds.add(li.id);
  }
  return { existingByProduct, ambiguousLineIds };
}

/**
 * SA-093 (#1185 review round 5, item B): `recomputeOrderFromInvoices` opens its own
 * `tenantTransaction`, under an order-keyed advisory lock, whenever it's called without a
 * caller-supplied `tx` (every real caller today). Extracted here (not inline in
 * invoices.service.ts, a size-ratchet-tracked file) since the lock/transaction/error-mapping
 * boilerplate is generic over the recompute callback.
 *
 * Deadlock analysis (both traps checked before this was written, per the review's own
 * requirement to stop and report rather than guess):
 *  (i) every real caller of `recomputeOrderFromInvoices` without a tx calls it strictly AFTER
 *      its own preceding write already committed (verified at each of invoices.service.ts's 3
 *      call sites: none holds an open transaction on this order's rows at the point it calls
 *      this) — so the NEW transaction this opens can never wait on a caller's still-open one
 *      while the caller waits on it.
 *  (ii) no path takes this order-keyed lock and then a customer-keyed "order-merge" lock (or
 *      vice versa): every OTHER "order-merge" family lock site (customer-merge,
 *      force-consolidate, the create/merge controller path) is scoped to DRAFT/PENDING orders
 *      ONLY (orders.service.ts's `findActiveOrder`), which by definition carry no invoice yet —
 *      structurally disjoint from this method's invoiced-order-only callers. No lock-order
 *      inversion with the customer-merge family.
 *
 * `mode: "wait"` either resolves acquired (fn ran) or the acquire itself rejects — it never
 * returns `{ acquired: false }` in practice (matches `applyAdvancePaymentToInvoice`'s own
 * pattern in customers.service.ts); the check below is defensive only, to type-check the result.
 */
export async function withOrderRecomputeLock<T>(
  prisma: {
    tenantTransaction<R>(fn: (tx: any) => Promise<R>, options?: { timeout?: number }): Promise<R>;
  },
  orderId: string,
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  let result;
  try {
    result = await withAdvisoryLock(
      // waitMs 10_000: the order-merge lock pool's own connectionTimeoutMillis budget is 10s
      // (common/db-locks.ts's lockPool) -- a 20_000 wait could never actually be reached; the
      // pool checkout itself would already have failed with LockUnavailableError well before it.
      { family: "order-merge", key: orderId, mode: "wait", waitMs: 10_000 },
      // {timeout: 15_000}, matching voidInvoice's own tenantTransaction call (invoices.service.ts
      // ~:4358) -- without it, Prisma's default 5s transaction timeout can fire on a busy order
      // before this recompute's own (already lock-serialized, so never actually concurrent with
      // a sibling) write work finishes.
      () => prisma.tenantTransaction((innerTx: any) => fn(innerTx), { timeout: 15_000 }),
    );
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.LOCK_UNAVAILABLE,
        message: "Another update to this order is in progress. Try again in a moment.",
      });
    }
    if (e instanceof LockUnavailableError) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.LOCK_UNAVAILABLE,
        message: "Order lock unavailable — retry shortly.",
      });
    }
    throw e;
  }
  if (!result.acquired) {
    throw new ServiceUnavailableException({
      code: API_ERROR_CODES.LOCK_UNAVAILABLE,
      message: "Order lock unavailable — retry shortly.",
    });
  }
  return result.value;
}

/**
 * B667 (#1185 review, finding 1): decide full coverage BEFORE any line is rewritten. A line
 * billed for only PART of its qty is still "matched" in byTarget, so checking matched-vs-not
 * AFTER the caller's update loop runs let a partially-billed line's own qty get silently shrunk
 * to whatever is currently billed (order qty 10, bill 6 -> row becomes qty 6). A line not
 * matched at all is judged against its own billable qty (finding 2, sharpened by round 5 item 1
 * below): under-billed-then-unmatched still blocks coverage; fully-billed-then-unmatched is a
 * genuine orphan-cancel candidate, not a blocker.
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
 *
 * ROUND 5 (SA-093 / independent Opus 5.5 pre-review):
 *
 * Item 1 (HIGH, money): the unmatched-line branch counted ANY prior invoicedQty > 0 as
 * "covered" — so a line billed for only PART of its qty (order qty 10, billed 4), then removed
 * from its invoice entirely, read as "covered" (4 > 0) even though 6 units were never billed.
 * With the whole order then reading fullyCovered, `finalizeOrderRecompute` cancelled the line
 * outright — losing the 6 legitimately-still-sellable units. Fixed: an unmatched line only
 * counts as covered when it was billed to its FULL billable qty (`>= billableQtyOf(li) -
 * QTY_EPSILON`, the same `allFullyInvoiced` rule `merge-idempotency.ts`'s
 * `shouldSkipInPlaceResync` already uses — imported from there, never a second literal). A
 * partial-then-removed line now falls through to the partial branch instead, which correctly
 * releases it (invoicedQty -> 0) rather than cancelling it.
 *
 * Item 2 (HIGH, money): an invoice item with no `orderItemId` resolves by product — but when a
 * product has MORE than one active order line, which one it actually bills is unknowable (the
 * caller's `existingByProduct` map picks a match anyway, silently crediting one active line's
 * billed qty onto an unrelated active sibling of the same product and releasing the other,
 * enabling a double-bill). `ambiguousLineIds` names every such line; the sync loop below SKIPS
 * a line named there ONLY when it has no precise `byTarget` match of its own (SA-093a round 6 —
 * see the loop's own comment: a line with a genuine orderItemId match is trusted regardless of
 * what its product-sharing siblings look like). Bails rather than guesses, the same principle
 * `resyncOrderInvoicesForEdit` applies to a provenance-less invoice line, at the per-line grain
 * this partial branch needs rather than that method's whole-order bail.
 *
 * SA-093a (round 6) — coverage basis is EVIDENCE-keyed, never order.status: see
 * `delivered-basis-by-line.ts`'s own doc for the full rule and why round 5's status-keyed
 * version was itself a money bug (finding 1: an order marked DELIVERED with no mutation rows
 * read every line as billable 0). The caller computes one `DeliveredBasis` per recompute (via
 * `deliveredBasisByLine`) and passes it to both this function and `finalizeOrderRecompute` —
 * ONE core, never two derivations. This is the ONLY change coverage needs: once
 * `billableQtyFromBasis` reflects the mutation-row basis, the CALLER's own existing-line
 * rewrite loop (gated on `fullyCovered`, in invoices.service.ts) already shrinks a short line's
 * qty/subtotal to what it was actually billed — that loop needed no change, only the threshold
 * that gates it.
 */
export async function checkOrderCoverage(params: {
  db: Prisma.TransactionClient;
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
  deliveredBasis: DeliveredBasis;
  /** SA-093a round 6: active line ids whose product has more than one active line — the sync
   *  loop only actually skips one when it ALSO has no precise `byTarget` match of its own (a
   *  genuine orderItemId always wins). Now rare in practice (a client sending a validated
   *  orderItemId matches precisely, never lands here); this fallback still exists for
   *  legacy/free-text items. The caller warns on every line actually skipped — never silent
   *  (ruling 2+3's "never silently" requirement). */
  ambiguousLineIds?: Set<string>;
}): Promise<
  | { fullyCovered: true }
  | { fullyCovered: false; totals: OrderRecomputeTotals; skippedAmbiguousLineIds: string[] }
> {
  const { db, orderId, order, byTarget, invoices, deliveredBasis, ambiguousLineIds } = params;
  const skippedAmbiguousLineIds: string[] = [];
  const activeLines = (order.lineItems as any[]).filter((li) => li.status !== "CANCELLED");
  const billableQtyOf = (li: any) => billableQtyFromBasis(li, deliveredBasis);
  // Reuse merge-idempotency.ts's shouldSkipInPlaceResync tolerance/zero-qty rule exactly: `qty`
  // is Decimal(10,3), and Node's float math (0.7 + 0.1 === 0.7999999999999999) means a strict
  // `>=` never counts a fully-billed line as covered. A zero-billable-qty line (never billable
  // at all, or an evidence row of 0 — a REFUSED delivery) can never block coverage either.
  const billableLines = activeLines.filter((li) => billableQtyOf(li) > QTY_EPSILON);
  const fullyCovered = billableLines.every((li) => {
    const agg = byTarget.get(`line:${li.id}`);
    if (agg) return agg.qty >= billableQtyOf(li) - QTY_EPSILON;
    // Round 5 item 1: only a line billed to its FULL billable qty counts as a covered/orphan
    // candidate when unmatched — a partial-then-removed line must fall through to the partial
    // branch below, which releases (not cancels) it.
    return Number(li.invoicedQty ?? 0) >= billableQtyOf(li) - QTY_EPSILON;
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
    // Round 5 item 2 / SA-093a round 6 (caller now warns, never silent): `ambiguousLineIds`
    // names every line sharing an ambiguous product, but that only matters when THIS line has
    // no precise match of its own — an invoice item that carried a valid orderItemId resolves
    // directly to `agg` regardless of what its product-sharing siblings look like, and must
    // never be skipped just because one of them is ambiguous (ruling 2+3's root fix: a real
    // orderItemId always wins over product-sharing ambiguity, never the other way around).
    if (!agg && ambiguousLineIds?.has(li.id)) {
      skippedAmbiguousLineIds.push(li.id);
      continue;
    }
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
    skippedAmbiguousLineIds,
  };
}

/**
 * B667 — the tail of `recomputeOrderFromInvoices`: cancel orphan order lines and rewrite the
 * order's totals to the sum of what its invoices bill. The CALLER decides whether it is safe to
 * be here at all — this only ever runs once every active order line is billed to its full
 * billable qty (the "wholly invoiced" precondition `resyncOrderInvoicesForEdit` documents,
 * reused not invented; see `checkOrderCoverage`'s own doc above for exactly what "billable"
 * means — evidence-keyed per `delivered-basis-by-line.ts`, never order status).
 *
 * ORPHAN DEFINITION (#1185 review, finding 2): among the lines no live invoice resolved to,
 * `invoicedQty > 0` means this line WAS billed and has since been removed from every invoice —
 * a genuine orphan, cancel it (this is the mechanism's original purpose: an invoice-side removal
 * back-syncing onto the order). `invoicedQty === 0` means never billed at all — it must never
 * reach here while still active on a line the delivered basis leaves unconstrained (the caller's
 * fullyCovered gate excludes it), but an already-CANCELLED line with stale non-zero qty/subtotal
 * (a prior return, a prior recompute) still gets its numbers normalized to zero.
 *
 * SA-093a, round 6: a line with its OWN evidence row showing 0 delivered (a REFUSED delivery)
 * is ALSO cancelled once the order is fully covered — the pre-PR behaviour, restored on purpose
 * for this specific line: a refused line was never going to be billed at all, so once delivery
 * is done there is nothing left pending for it. This is keyed on THAT line's own evidence row,
 * never on order.status (see `delivered-basis-by-line.ts`) — a line with no evidence row of its
 * own is never "refused" by this rule, whatever the order's other lines or status say.
 */
export async function finalizeOrderRecompute(params: {
  db: Prisma.TransactionClient;
  orderId: string;
  order: { subtotal: unknown; tax: unknown; total?: unknown; shippingFee?: unknown };
  deliveredBasis: DeliveredBasis;
  /** Order lines no invoice line resolved to (the caller's existing-line loop already removed
   *  every line it matched). */
  unbilled: Map<string, { id: string; status?: string; invoicedQty?: unknown }>;
  subtotal: number;
  categoryTaxSum: number;
  invoices: any[];
}): Promise<OrderRecomputeTotals> {
  const { db, orderId, order, deliveredBasis, unbilled, categoryTaxSum, invoices } = params;

  // Cancel a genuine orphan (was billed, now removed), a line refused by its OWN evidence row,
  // and normalize an already-cancelled line's stale qty/subtotal. A line that was NEVER billed
  // and isn't refused/already-cancelled is left untouched — it should not appear here at all
  // while the caller's gate holds.
  for (const orphan of unbilled.values()) {
    const wasBilled = Number(orphan.invoicedQty ?? 0) > 0;
    const alreadyCancelled = orphan.status === "CANCELLED";
    const deliveredForLine = deliveredBasis.byLineId.get(orphan.id);
    const refused = deliveredForLine !== undefined && deliveredForLine <= QTY_EPSILON;
    if (!wasBilled && !alreadyCancelled && !refused) continue;
    // SA-235: a line that already holds exactly these values is not written (no updatedAt churn).
    const cancelled: Array<[string, unknown]> = [
      ["status", "CANCELLED"],
      ["qty", 0],
      ["subtotal", 0],
      ["boxes", null],
      ["pieces", null],
      ["invoicedQty", 0],
    ];
    if (holdsValues(orphan, cancelled)) continue;
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
  // Shipping back-sync: the order's fee is DEFINED as Σ(non-void invoice fees) — an invoice-side
  // fee edit lands here and updates the order, which is what lets the order-driven reconciles
  // treat the order as source of truth.
  const shippingFeeSum = roundMoney(
    invoices.reduce((s: number, inv: any) => s + Number(inv.shippingFee ?? 0), 0),
  );
  // RF-4: fold the billed category tax (Σ per line) back into the order total, so the order
  // stays in step with what the invoices actually charged. The ONE formula (`sumInvoiceTotals`).
  const { regularTax: tax, total } = sumInvoiceTotals(
    [{ subtotal, taxRate: effectiveTaxRate, categoryTaxAmount: categoryTaxSum }],
    { shipping: shippingFeeSum },
  );
  // SA-235: the Order row is written only when a column it would write differs (an identical save moves no updatedAt).
  const orderWrites: Array<[string, unknown]> = [
    ["subtotal", subtotal],
    ["tax", tax],
    ["total", total],
    ["shippingFee", shippingFeeSum],
  ];
  if (!holdsValues(order, orderWrites)) {
    await db.order.update({
      where: { id: orderId },
      data: { subtotal, tax, total, shippingFee: shippingFeeSum },
    });
  }
  return { orderId, subtotal, tax, total, shippingFee: shippingFeeSum };
}
