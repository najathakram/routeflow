/**
 * SA-151 (B692, #938 5814561170): a manual `changeStatus` to DELIVERED/PARTIALLY_DELIVERED wrote
 * only `deliveredAt`, never `deliveredQty` or any `DeliveryMutation` evidence — only a route
 * stop's completion path did (routes.service.ts). Consequence: an order marked DELIVERED by
 * staff in the office (not through a completed route stop) read `deliveredQty` 0 everywhere else
 * that trusts it (order-cancel-impact.ts's B56 blanket-void gate, order-stock.ts's credit clamp),
 * so cancelling it restored full stock and voided every invoice as if nothing had shipped.
 *
 * Fix, under SA-113a's "one basis everywhere" rule: an office DELIVERED creates evidence too, via
 * the SAME `DeliveryMutation` + `deliveredQtyRecompute` (B785, #1353) machinery the route-stop
 * path uses — `routeRunStopId`/`driverId` null (no stop, no driver), `note: "OFFICE_MARKED"`.
 * PARTIALLY_DELIVERED either carries its own `deliveries[]` (same shape as `completeWithPayment`,
 * fit-checked against what remains) or requires the order already have evidence from an earlier
 * write; a bare flip with neither is refused — there is no way to derive a partial split from
 * nothing.
 *
 * Deliberately NOT a stock movement (SA-133 (3)): stock moves at SALE, never at delivery.
 * `deliveredQty` only ever CLAMPS a later credit (order-stock.ts, order-cancel-impact.ts) — this
 * module writes evidence and recomputes that clamp, nothing more.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import {
  deliveredQtyRecompute,
  fetchEvidenceByLine,
  sumDeliveredSoFar,
} from "../routes/delivered-so-far";

export interface OfficeMarkTx {
  orderItem: {
    findMany(args: any): Promise<any[]>;
    update(args: any): Promise<any>;
  };
  deliveryMutation: {
    findMany(args: any): Promise<any[]>;
    create(args: any): Promise<any>;
  };
}

/**
 * Manual DELIVERED: one `DeliveryMutation` per active line for whatever remains undelivered
 * (`qty − deliveredSoFar`, evidence-based, never the bare stored qty — a line already partly
 * delivered on a route stop must only get evidence for what THAT stop left outstanding). A
 * fully-covered line gets no row. Then recomputes `deliveredQty` for every active line from the
 * full evidence set, matching the route-stop path exactly.
 */
export async function writeOfficeMarkedDeliveredEvidence(
  tx: OfficeMarkTx,
  orderId: string,
): Promise<void> {
  const activeItems: Array<{ id: string; productId: string | null; qty: unknown }> =
    await tx.orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
      select: { id: true, productId: true, qty: true },
    });
  const evidenceByLine = await fetchEvidenceByLine(tx, [orderId]);
  for (const li of activeItems) {
    // No stop to exclude here — an office mark isn't attributed to one, so `undefined` (never
    // equal to any real `routeRunStopId`, including a prior office mark's own `null`) excludes
    // nothing and sums the TRUE prior evidence.
    const deliveredSoFar = sumDeliveredSoFar(evidenceByLine[orderId]?.[li.id], undefined);
    const remaining = Number(li.qty) - deliveredSoFar;
    if (remaining <= 0.0005) continue;
    await tx.deliveryMutation.create({
      data: {
        orderId,
        orderItemId: li.id,
        productId: li.productId,
        routeRunStopId: null,
        driverId: null,
        type: "DELIVERED",
        quantityDelivered: remaining,
        note: "OFFICE_MARKED",
      },
    });
  }
  await recomputeDeliveredQty(
    tx,
    orderId,
    activeItems.map((li) => li.id),
  );
}

/**
 * Manual PARTIALLY_DELIVERED. Three shapes:
 *  - no `deliveries` and the order already carries evidence (a prior office mark, or a route
 *    stop's partial) → allowed, writes nothing — the existing evidence already reflects reality.
 *  - no `deliveries` and NO existing evidence → refused (409 `DELIVERY_QUANTITIES_REQUIRED`):
 *    there is no way to derive which lines/quantities were actually delivered from nothing.
 *  - `deliveries` present → fit-checked against each line's own remaining (evidence-based, same
 *    rule as `assertDeliveriesFitStop`), then written + recomputed exactly like the DELIVERED
 *    path above, restricted to the lines named.
 */
export async function applyOfficePartialDeliveryEvidence(
  tx: OfficeMarkTx,
  orderId: string,
  deliveries:
    ReadonlyArray<{ orderItemId: string; quantityDelivered: number; note?: string }> | undefined,
): Promise<void> {
  const activeItems: Array<{
    id: string;
    productId: string | null;
    qty: unknown;
    deliveredQty: unknown;
  }> = await tx.orderItem.findMany({
    where: { orderId, status: { not: "CANCELLED" } },
    select: { id: true, productId: true, qty: true, deliveredQty: true },
  });

  if (!deliveries || deliveries.length === 0) {
    const hasExistingEvidence = activeItems.some((li) => Number(li.deliveredQty ?? 0) > 0);
    if (!hasExistingEvidence) {
      throw new ConflictException({
        code: "DELIVERY_QUANTITIES_REQUIRED",
        message:
          "A partial delivery needs per-line quantities — this order has no delivery evidence yet.",
      });
    }
    return; // existing evidence already covers this order; nothing new to write.
  }

  const byId = new Map(activeItems.map((li) => [li.id, li]));
  const evidenceByLine = await fetchEvidenceByLine(tx, [orderId]);
  const seen = new Set<string>();
  for (const d of deliveries) {
    if (seen.has(d.orderItemId)) {
      throw new BadRequestException(
        `Order item ${d.orderItemId} appears in more than one delivery line`,
      );
    }
    seen.add(d.orderItemId);
    const item = byId.get(d.orderItemId);
    if (!item)
      throw new NotFoundException(`Order item ${d.orderItemId} was not found on this order`);
    const deliveredSoFar = sumDeliveredSoFar(evidenceByLine[orderId]?.[d.orderItemId], undefined);
    const remaining = Number(item.qty) - deliveredSoFar;
    const q = Number(d.quantityDelivered);
    if (!Number.isFinite(q) || q < 0 || q > remaining + 0.0005) {
      throw new BadRequestException(
        `Delivery quantity for order item ${d.orderItemId} must be between 0 and the remaining undelivered quantity`,
      );
    }
    if (q <= 0.0005) continue; // a REFUSED/untouched line's evidence isn't worth a zero row.
    await tx.deliveryMutation.create({
      data: {
        orderId,
        orderItemId: d.orderItemId,
        productId: item.productId,
        routeRunStopId: null,
        driverId: null,
        type: "DELIVERED",
        quantityDelivered: q,
        note: d.note ?? "OFFICE_MARKED",
      },
    });
  }
  await recomputeDeliveredQty(
    tx,
    orderId,
    activeItems.map((li) => li.id),
  );
}

async function recomputeDeliveredQty(
  tx: OfficeMarkTx,
  orderId: string,
  itemIds: string[],
): Promise<void> {
  for (const u of await deliveredQtyRecompute(tx, orderId, itemIds)) {
    await tx.orderItem.update({ where: { id: u.id }, data: { deliveredQty: u.deliveredQty } });
  }
}
