import { BadRequestException } from "@nestjs/common";

/**
 * Refuse a delivery payload BEFORE any write. Every line must (1) belong to an order carried by
 * THIS stop — a driver owns the run, not the tenant's other orders, and each line drives a
 * DeliveryMutation, `deliveredQty` and the delivered-basis invoice reconcile of the order it
 * names — and (2) deliver a finite quantity within [0, ordered qty]: `billQty` is `deliveredQty`
 * unclamped, so an over-delivered line would bill units nobody ordered. Ids that resolve to no
 * item (tenant-scoped read) are skipped by the write loops exactly as before.
 *
 * `tx` is the tenant-scoped transaction client (tenantTransaction), so the item read can never
 * see another tenant's rows.
 */
export async function assertDeliveriesFitStop(
  tx: any,
  stopOrders: readonly { id: string }[],
  deliveries: readonly { orderItemId: string; quantityDelivered: number }[] | undefined,
): Promise<void> {
  if (!deliveries || deliveries.length === 0) return;
  const items: { id: string; orderId: string; qty: unknown }[] = await tx.orderItem.findMany({
    where: { id: { in: deliveries.map((d) => d.orderItemId) } },
    select: { id: true, orderId: true, qty: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const onStop = new Set(stopOrders.map((o) => o.id));
  for (const d of deliveries) {
    const item = byId.get(d.orderItemId);
    if (!item) continue;
    if (!onStop.has(item.orderId)) {
      throw new BadRequestException("A delivery line does not belong to this stop");
    }
    const q = Number(d.quantityDelivered);
    if (!Number.isFinite(q) || q < 0 || q > Number(item.qty) + 0.0005) {
      throw new BadRequestException(
        "A delivery line's quantity must be between 0 and the ordered quantity",
      );
    }
  }
}
