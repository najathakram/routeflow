/**
 * Returns Inside Order Creation — PR-1c: the driver-cap cumulative sum (§4 N-5) and the
 * "carrying order is met" predicate (§6.3) both need the SAME figure — the credit already
 * committed against an order's inline returns — so it lives here once rather than being
 * re-derived at each call site (orders.service.ts's DRIVER edit-down guard,
 * InlineReturnsService.capture()'s cap check, and credit-notes.service.ts's sweep
 * exclusion all import this file).
 */
import { roundMoney } from "@routeflow/pricing";

/** Minimal shape `sumInlineReturnCredit` needs from a transaction/prisma client. */
export interface InlineReturnCreditTx {
  return: {
    findMany: (args: any) => Promise<any[]>;
  };
}

/**
 * §4 N-5: Σ = committed credit of every RECEIVED/REFUNDED INLINE return on `orderId`.
 *
 * Opus review (PR-1c BLOCK, HIGH-1): summing `refundAmount ?? heldAmount` left a captured
 * row INVISIBLE to this sum for the entire gap between the capture transaction's commit and
 * `issueCredit`'s own commit — `refundAmount` isn't set until the credit note is linked,
 * and (pre-fix) `heldAmount` was only set for an OVER-cap hold. Two parallel DRIVER captures
 * could both read Σ during that gap, both pass the cap check, and together exceed it; the
 * same blind spot made `orders.service.ts`'s `ORDER_BELOW_RETURN_CREDIT` guard read a stale
 * (too-low) Σ too.
 *
 * Fixed by summing `creditSubtotal + creditTax + creditCategoryTax` instead — capture()
 * writes all three on the SAME row create as the priced figures, before either
 * `refundAmount` or `heldAmount` exists, so they are visible to a concurrent reader the
 * instant the capture transaction commits, for every RECEIVED (held or not) and REFUNDED
 * row alike. `status: {in: ["RECEIVED", "REFUNDED"]}` excludes PENDING (1d's not-yet-
 * captured order-hook rows — nothing committed yet), REJECTED (credit was declined, never
 * committed) and CANCELLED (m-5 — reversed) by construction. Read under the CALLER's own
 * carrying-order lock (this never locks anything itself).
 */
export async function sumInlineReturnCredit(
  tx: InlineReturnCreditTx,
  orderId: string,
): Promise<number> {
  const rows = await tx.return.findMany({
    where: { orderId, kind: "INLINE", status: { in: ["RECEIVED", "REFUNDED"] } },
    select: { creditSubtotal: true, creditTax: true, creditCategoryTax: true },
  });
  return roundMoney(
    rows.reduce(
      (sum: number, r: any) =>
        sum +
        Number(r.creditSubtotal ?? 0) +
        Number(r.creditTax ?? 0) +
        Number(r.creditCategoryTax ?? 0),
      0,
    ),
  );
}
