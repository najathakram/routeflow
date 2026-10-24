import { QTY_EPSILON } from "../orders/merge-idempotency";
import type { UnvoidRefusalReason } from "./unvoid-billing-refusal";

/** The invoice-line and order-line columns the plan reads (B299 / SA-814). */
export interface ClaimInvoiceLine {
  productId: string | null;
  qty: unknown;
  orderItemId: string | null;
}
export interface ClaimOrderLine {
  id: string;
  productId: string | null;
  status?: string | null;
  qty?: unknown;
  invoicedQty?: unknown;
}

export type InvoicedQtyPlan =
  { refusal: UnvoidRefusalReason } | { writes: Array<{ id: string; invoicedQty: number }> };

/**
 * Pure plan for `adjustInvoicedQtyForInvoice`: resolves every invoice line to its order line, then (re-claim,
 * direction +1) refuses unless the quantity is still free, or (release, -1) clamps into [0, line qty]. The
 * caller reads the rows under its locks, throws on `refusal`, and performs `writes`. B299 / SA-814 / SA-814d / SA-814f.
 */
export function planInvoicedQtyAdjustment(
  items: ClaimInvoiceLine[],
  orderItems: ClaimOrderLine[],
  direction: -1 | 1,
): InvoicedQtyPlan {
  // Precise path: the exact source order line. Legacy path: lines with no provenance, aggregated by product.
  const byOrderItem = new Map<string, number>();
  const byProduct = new Map<string, number>();
  for (const it of items) {
    if (it.orderItemId) {
      byOrderItem.set(it.orderItemId, (byOrderItem.get(it.orderItemId) ?? 0) + Number(it.qty));
    } else if (it.productId) {
      byProduct.set(it.productId, (byProduct.get(it.productId) ?? 0) + Number(it.qty));
    }
  }

  const claims = new Map<string, { oi: ClaimOrderLine; qty: number; cancelledTarget: boolean }>();
  const claim = (oi: ClaimOrderLine, qty: number, cancelledTarget = false) => {
    const prior = claims.get(oi.id);
    claims.set(oi.id, {
      oi,
      qty: (prior?.qty ?? 0) + qty,
      cancelledTarget: (prior?.cancelledTarget ?? false) || cancelledTarget,
    });
  };
  // SA-814: a line with NO matching order line at all (the order line was hard-deleted, orderItemId SetNull,
  // and the product is not on the order) is skipped on release (-1) but refused on re-claim (+1). Free-form
  // lines (no orderItemId AND no productId) never enter either map: no order linkage by design.
  let unmatchedLines = 0;
  for (const [orderItemId, qty] of byOrderItem) {
    const target = orderItems.find((oi) => oi.id === orderItemId);
    if (target) claim(target, qty, target.status === "CANCELLED");
    else unmatchedLines += 1;
  }
  for (const [productId, qty] of byProduct) {
    // #1185 round 5, item 3: never pick a CANCELLED line as the fallback target.
    // Legacy productId fallback: duplicate products on the order claim the whole product total on the FIRST
    // live line (fails closed on a re-claim: that line runs out of free qty).
    const live = orderItems.find((oi) => oi.productId === productId && oi.status !== "CANCELLED");
    if (live) claim(live, qty);
    else if (direction === 1) {
      // B299: the goods only exist on a cancelled line - nothing live to re-claim them on.
      const cancelled = orderItems.find((oi) => oi.productId === productId);
      if (cancelled) claim(cancelled, qty, true);
      // SA-814f: an unlinked product line with no order line at all is skipped like a free-form line.
      // Accepted residual: void -> hard-delete the uninvoiced order line -> unvoid is a mismatch, not a double bill.
    }
  }

  if (direction === 1) {
    // B299 / SA-814 R4-5: a re-claim is never clamped. Under the caller's locks every line must still
    // have `qty - invoicedQty >= delta` on a non-CANCELLED order line; otherwise another invoice bills
    // these goods now and restoring this one would double-bill them. No write has happened yet.
    // SA-814d: `reason` tells the two apart. A is VOID and its qty was released, so `invoicedQty > 0` on
    // the line means OTHER invoices bill it (OTHER_INVOICE, which wins across lines); otherwise the line
    // just holds less than A bills (LINE_REDUCED; an unmatched or cancelled line holds 0).
    let refusal: UnvoidRefusalReason | null = unmatchedLines > 0 ? "LINE_REDUCED" : null;
    for (const { oi, qty, cancelledTarget } of claims.values()) {
      const free = Number(oi.qty ?? 0) - Number(oi.invoicedQty ?? 0);
      if (cancelledTarget || free < qty - QTY_EPSILON) {
        if (Number(oi.invoicedQty ?? 0) > QTY_EPSILON) refusal = "OTHER_INVOICE";
        else refusal ??= "LINE_REDUCED";
      }
    }
    if (refusal) return { refusal };
  }

  const writes = [...claims.values()].map(({ oi, qty }) => ({
    id: oi.id,
    // Void direction: clamp into [0, line qty] (never negative, never more than the line has). The
    // re-claim direction was verified above, so its sum is already within the line.
    invoicedQty: Math.min(
      Number(oi.qty ?? 0),
      Math.max(0, Number(oi.invoicedQty ?? 0) + direction * qty),
    ),
  }));
  return { writes };
}
