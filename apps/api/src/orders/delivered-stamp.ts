import { deliveredBasisByLine, type DeliveredBasis } from "../invoices/delivered-basis-by-line";

/**
 * The delivered-quantity stamp helpers of an order's lines (SA-762r). One home for the rules about the `deliveredQty`
 * column that is written WITHOUT a route stop: `clearUnevidencedDelivered` (below, the counter-sale void) and, beside
 * it, the POS-mode `stampDeliveredInFull`. Both share ONE definition of "this line has delivery evidence".
 */

/**
 * ONE definition of "this line has qualifying DeliveryMutation evidence": the line owns at least one qualifying row of
 * the delivery-evidence reader (invoices/delivered-basis-by-line.ts: a delivery-evidence type with a non-null
 * quantityDelivered, a REFUSED row included). `basis` comes from `deliveredBasisByLine(tx, orderId)`.
 */
export const hasDeliveryEvidence = (basis: DeliveredBasis, lineId: string): boolean =>
  basis.byLineId.has(lineId);

/**
 * The counter-sale void undoes the hand-over. A counter sale hands the goods over at the till, with no route and no
 * evidence row, and the cancel unwind (cancelOrderInTx -> settleStockForEdit) keeps DELIVERED units booked: a line that
 * reads `deliveredQty = qty` would be cancelled with NOTHING restocked. Today's createSale stamps no deliveredQty
 * (B1050), so this is a no-op on master; it is the net for a DELIVERED write that does stamp it (POS mode).
 *
 * Runs inside the void's transaction after the Order lock and BEFORE the cancel; zeroes `deliveredQty` ONLY on live
 * lines WITHOUT evidence. A line with evidence is never rewritten, and an order that rode a route stop
 * (`routeRunStopId`) is not touched at all. Only the counter-sale void imports it (the generic office cancel and the
 * demotion keep the stamp, structure-pinned in counter-sale-void-handover.structure.spec.ts). Returns the zeroed line ids.
 */
export async function clearUnevidencedDelivered(tx: any, orderId: string): Promise<string[]> {
  const order: { routeRunStopId: string | null } | null = await tx.order.findUnique({
    where: { id: orderId },
    select: { routeRunStopId: true },
  });
  if (!order || order.routeRunStopId) return [];
  const handed: Array<{ id: string }> = await tx.orderItem.findMany({
    where: { orderId, deliveredQty: { gt: 0 }, status: { not: "CANCELLED" } },
    select: { id: true },
  });
  if (handed.length === 0) return [];
  const basis = await deliveredBasisByLine(tx, orderId);
  const ids = handed.map((l) => l.id).filter((id) => !hasDeliveryEvidence(basis, id));
  if (ids.length === 0) return [];
  await tx.orderItem.updateMany({ where: { id: { in: ids }, orderId }, data: { deliveredQty: 0 } });
  return ids;
}
