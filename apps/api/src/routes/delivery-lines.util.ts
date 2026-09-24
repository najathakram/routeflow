import { BadRequestException, NotFoundException } from "@nestjs/common";
import { fetchEvidenceByLine, sumDeliveredSoFar } from "./delivered-so-far";

/**
 * Refuse a delivery payload BEFORE any write. Every line must (1) belong to an order carried by
 * THIS stop — a driver owns the run, not the tenant's other orders, and each line drives a
 * DeliveryMutation, `deliveredQty` and the delivered-basis invoice reconcile of the order it
 * names — and (2) deliver a finite quantity within [0, REMAINING qty]: `billQty` is
 * `deliveredQty` unclamped, so an over-delivered line would bill units nobody ordered. An item id
 * may appear once (each duplicate would pass the cap on its own), and an id that resolves to no
 * item — the read is tenant-scoped, so a foreign tenant's item looks exactly like a missing one —
 * is a 404. Every refusal names the offending item.
 *
 * B785/SA-116/SA-133: the cap is `ordered qty − deliveredSoFar`, not the full ordered qty — a
 * second visit (re-delivery, a reopened partial) must never be allowed to deliver more than the
 * order still has outstanding. `deliveredSoFar` excludes THIS stop's own rows (`delivered-so-far.ts`,
 * shared with the run/stop read projection) — the ordinary flow calls this before any row of
 * this completion is written, so there is nothing of this stop's to exclude yet, but the
 * exclusion still guards an idempotency replay or a defensive re-check from double-counting this
 * stop's own prior attempt. A REFUSED evidence row contributes 0, so a previously-refused line's
 * full ordered qty remains available to a later re-delivery attempt.
 *
 * `tx` is the tenant-scoped transaction client (tenantTransaction), so the item read can never
 * see another tenant's rows.
 */
export async function assertDeliveriesFitStop(
  tx: any,
  stopId: string,
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
  const evidenceByLine = await fetchEvidenceByLine(tx, [...new Set(items.map((i) => i.orderId))]);
  const seen = new Set<string>();
  for (const d of deliveries) {
    if (seen.has(d.orderItemId)) {
      throw new BadRequestException(
        `Order item ${d.orderItemId} appears in more than one delivery line`,
      );
    }
    seen.add(d.orderItemId);
    const item = byId.get(d.orderItemId);
    if (!item) throw new NotFoundException(`Order item ${d.orderItemId} was not found`);
    if (!onStop.has(item.orderId)) {
      throw new BadRequestException(`Order item ${d.orderItemId} does not belong to this stop`);
    }
    const deliveredSoFar = sumDeliveredSoFar(evidenceByLine[item.orderId]?.[item.id], stopId);
    const remaining = Number(item.qty) - deliveredSoFar;
    const q = Number(d.quantityDelivered);
    if (!Number.isFinite(q) || q < 0 || q > remaining + 0.0005) {
      throw new BadRequestException(
        `Delivery quantity for order item ${d.orderItemId} must be between 0 and the remaining undelivered quantity`,
      );
    }
  }
}
