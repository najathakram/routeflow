/**
 * SA-093a (round 6, #1185): the delivered basis for coverage/billing is EVIDENCE-keyed — real
 * `DeliveryMutation` rows — never `order.status` and never `OrderItem.deliveredQty`.
 *
 * Why: on master, `DeliveryMutation` rows are written by THREE independent sites
 * (`routes.service.ts`'s `completeStop` and `completeWithPayment`, `orders.service.ts`'s
 * at-door change-request approval), but the `deliveredQty` COLUMN is written by
 * `completeWithPayment` alone. `changeStatus` ("mark delivered" from the office), the van
 * sale, and `completeStop` can all set `order.status = "DELIVERED"` without ever stamping
 * `deliveredQty` or writing a single mutation row. Keying coverage on `order.status ===
 * "DELIVERED"` (round 5's rule) therefore read every line on those orders as billable 0 and
 * `finalizeOrderRecompute` cancelled all of them — a $100 order silently going to $0
 * (independent Opus 5.5 re-read, finding 1, verified on master by the fleet lead).
 *
 * The rule, precisely:
 *  - A line's billable qty = min(qty, its own DeliveryMutation-row qty). A REFUSED-type row
 *    contributes 0 regardless of any qty value it carries (the delivery was refused, not
 *    partially made) — never a negative, never the ordered qty.
 *  - A line with NO mutation row of its own keeps `qty` unconstrained (round 4's rule) — a
 *    mutation elsewhere on the order says nothing about a line delivery never touched.
 *  - An order with NO mutation rows AT ALL behaves as undelivered, regardless of its status —
 *    `order.status` is read for nothing here.
 *  - `OrderItem.deliveredQty` is NEVER read for coverage. It may still be written (legacy,
 *    `completeWithPayment`) but this module never consults it.
 *
 * ONE core, never two derivations: `checkOrderCoverage`, `finalizeOrderRecompute` AND (once
 * B760 resumes) the invoice "remaining to bill" calculations all call `billableQtyFromBasis`
 * against the SAME `DeliveredBasis` a caller computes once via `deliveredBasisByLine`.
 */
export interface DeliveredBasis {
  /** True iff the order has at least one DeliveryMutation row at all (any line). */
  hasMutations: boolean;
  /** orderItemId -> Σ delivered qty from that line's own mutation rows (REFUSED contributes 0). */
  byLineId: Map<string, number>;
}

export async function deliveredBasisByLine(db: any, orderId: string): Promise<DeliveredBasis> {
  const mutations = await db.deliveryMutation.findMany({
    where: { orderId },
    select: { orderItemId: true, type: true, quantityDelivered: true, qty: true },
  });
  const byLineId = new Map<string, number>();
  for (const m of mutations as any[]) {
    if (!m.orderItemId) continue; // a free-text/no-line mutation attributes to nothing
    // `completeStop`/`completeWithPayment` write `quantityDelivered`; the at-door
    // change-request approval site (orders.service.ts) writes the older `qty` field instead.
    const delta = m.type === "REFUSED" ? 0 : Number(m.quantityDelivered ?? m.qty ?? 0);
    byLineId.set(m.orderItemId, (byLineId.get(m.orderItemId) ?? 0) + delta);
  }
  return { hasMutations: mutations.length > 0, byLineId };
}

export function billableQtyFromBasis(
  li: { id: string; qty: unknown },
  basis: DeliveredBasis,
): number {
  const qty = Number(li.qty ?? 0);
  if (!basis.hasMutations) return qty;
  const delivered = basis.byLineId.get(li.id);
  if (delivered === undefined) return qty;
  return Math.min(qty, delivered);
}
