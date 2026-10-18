/**
 * B692 (SA-814 R4-3): a manual PARTIALLY_DELIVERED carries what was delivered, and a delivered order with no
 * recorded quantity is never cancelled blind.
 *
 * Why: `updateStatusWithShipMarker` stamps only DELIVERED (delivered-stamp.ts). A bare manual flip to
 * PARTIALLY_DELIVERED wrote no `deliveredQty` and no evidence row, so cancel-impact (B56) read "nothing
 * delivered": the cancel credited every unit back and voided every invoice for goods the customer holds.
 *
 * Two halves, ONE predicate (`deliveryQuantitiesMissing`):
 *  - `recordPartialDeliveryInTx` runs INSIDE the status transaction: it writes the caller's per-line quantities
 *    as DeliveryMutation evidence (the route-stop machinery: `deliveredQtyRecompute`, rows beat the column) and
 *    refuses 409 ORDER_PD_NEEDS_QUANTITIES, rolling the status back with it, when after that the order still
 *    carries no delivery signal (no line with deliveredQty > 0 and no evidence row).
 *  - `assertDeliveryQuantitiesKnown` is the cancel's fail-closed read for LEGACY rows: a DELIVERED or
 *    PARTIALLY_DELIVERED order whose active lines all read deliveredQty 0 and that has no evidence row is
 *    refused 409 ORDER_DELIVERY_QUANTITIES_MISSING, never treated as undelivered.
 *
 * Deliberately NOT a stock movement: stock moves at SALE (SA-133 (3)); `deliveredQty` only clamps a later credit.
 * Out of scope (noted): an office DELIVERED skips lines that already hold route evidence and route-stop orders
 * (delivered-stamp.ts), so those keep their evidence-based figures.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { deliveredBasisByLine } from "../invoices/delivered-basis-by-line";
import {
  deliveredQtyRecompute,
  fetchEvidenceByLine,
  sumDeliveredSoFar,
} from "../routes/delivered-so-far";

const EPS = 0.0005;

/** One office-recorded delivery line (`ChangeOrderStatusDto.deliveries[]`). */
export interface OfficeDeliveryLine {
  orderItemId: string;
  quantityDelivered: number;
  note?: string;
}

export const PD_NEEDS_QUANTITIES_MESSAGE = "Record what was delivered for each line first.";
export const DELIVERY_QUANTITIES_MISSING_MESSAGE =
  "Delivery quantities are missing; set them before cancelling.";

/** The statuses whose goods have (at least partly) left: where a missing quantity is a data gap, not "undelivered". */
export const DELIVERED_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.PARTIALLY_DELIVERED,
];

/**
 * THE predicate: the order has active lines, every one reads deliveredQty 0, and no qualifying
 * DeliveryMutation row exists (a REFUSED row counts: it records a resolved attempt). The line read comes first
 * and short-circuits, so an order with a stamped line never pays for the evidence read.
 */
export async function deliveryQuantitiesMissing(db: any, orderId: string): Promise<boolean> {
  const lines: Array<{ deliveredQty: unknown }> = await db.orderItem.findMany({
    where: { orderId, status: { not: "CANCELLED" } },
    select: { id: true, deliveredQty: true },
  });
  if (lines.length === 0) return false; // nothing to deliver, nothing missing
  if (lines.some((l) => Number(l.deliveredQty ?? 0) > EPS)) return false;
  return !(await deliveredBasisByLine(db, orderId)).hasMutations;
}

/**
 * The cancel's pre-check (cancelImpact): true for a DELIVERED / PARTIALLY_DELIVERED order whose delivery
 * quantities are unknown. Any other status reads nothing (no extra query).
 */
export async function cancelBlockedByMissingQuantities(
  db: any,
  order: { id: string; status: string },
): Promise<boolean> {
  if (!DELIVERED_STATUSES.includes(order.status as OrderStatus)) return false;
  return deliveryQuantitiesMissing(db, order.id);
}

/** The cancel refusal for a legacy delivered row (409, before any write). */
export function throwDeliveryQuantitiesMissing(): never {
  throw new ConflictException({
    code: API_ERROR_CODES.ORDER_DELIVERY_QUANTITIES_MISSING,
    message: DELIVERY_QUANTITIES_MISSING_MESSAGE,
  });
}

/**
 * Writes the named per-line quantities as DeliveryMutation evidence and recomputes `deliveredQty` from the
 * rows. Each quantity is fit-checked against the line's own remaining (qty - the line's evidence so far, the
 * route-stop bound); a duplicate or foreign line id is refused. Zero-quantity entries write nothing. Runs in
 * the caller's transaction.
 */
async function writeOfficeDeliveries(
  tx: any,
  orderId: string,
  deliveries: readonly OfficeDeliveryLine[],
): Promise<void> {
  const items: Array<{ id: string; productId: string | null; qty: unknown }> =
    await tx.orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
      select: { id: true, productId: true, qty: true },
    });
  const byId = new Map(items.map((li) => [li.id, li]));
  const evidence = await fetchEvidenceByLine(tx, [orderId]);
  const seen = new Set<string>();
  const touched: string[] = [];
  for (const d of deliveries) {
    if (seen.has(d.orderItemId)) {
      throw new BadRequestException(`Order item ${d.orderItemId} appears in more than one line`);
    }
    seen.add(d.orderItemId);
    const item = byId.get(d.orderItemId);
    if (!item)
      throw new NotFoundException(`Order item ${d.orderItemId} was not found on this order`);
    // No stop to exclude (an office record is attributed to none): `undefined` equals no row's stop id.
    const remaining = Number(item.qty) - sumDeliveredSoFar(evidence[orderId]?.[item.id], undefined);
    const q = Number(d.quantityDelivered);
    if (!Number.isFinite(q) || q < 0 || q > remaining + EPS) {
      throw new BadRequestException(
        `Delivered quantity for order item ${d.orderItemId} must be between 0 and the quantity still undelivered`,
      );
    }
    if (q <= EPS) continue;
    await tx.deliveryMutation.create({
      data: {
        orderId,
        orderItemId: item.id,
        productId: item.productId ?? null,
        routeRunStopId: null,
        driverId: null,
        type: q + EPS >= remaining ? "DELIVERED" : "PARTIAL",
        quantityDelivered: q,
        note: d.note ?? "OFFICE_MARKED",
      },
    });
    touched.push(item.id);
  }
  for (const u of await deliveredQtyRecompute(tx, orderId, touched)) {
    await tx.orderItem.update({ where: { id: u.id }, data: { deliveredQty: u.deliveredQty } });
  }
}

/**
 * The manual PARTIALLY_DELIVERED's delivery data, in the status write's transaction (after the status CAS).
 * Writes `deliveries` when given, then requires a delivery signal on the order: `deliveries[]` or existing
 * evidence. Without either: 409 ORDER_PD_NEEDS_QUANTITIES (the throw rolls the status write back).
 */
export async function recordPartialDeliveryInTx(
  tx: any,
  orderId: string,
  deliveries: readonly OfficeDeliveryLine[] | undefined,
): Promise<void> {
  if (deliveries && deliveries.length > 0) await writeOfficeDeliveries(tx, orderId, deliveries);
  if (await deliveryQuantitiesMissing(tx, orderId)) {
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_PD_NEEDS_QUANTITIES,
      message: PD_NEEDS_QUANTITIES_MESSAGE,
    });
  }
}

/**
 * A step OUT of PARTIALLY_DELIVERED (to OUT_FOR_DELIVERY, "Back out for delivery") in the status write's
 * transaction (after the status CAS, so the order row is locked). A legacy PD row with no delivery signal must
 * not step back: OUT_FOR_DELIVERY -> CANCELLED would restock every unit and void every invoice for goods the
 * customer holds, the cancel guard's blind spot. `deliveries[]` on the request is stamped first (as the PD path
 * does); if the order still has no signal: 409 ORDER_DELIVERY_QUANTITIES_MISSING, which rolls the status back.
 */
export async function leavePartialDeliveryInTx(
  tx: any,
  orderId: string,
  deliveries: readonly OfficeDeliveryLine[] | undefined,
): Promise<void> {
  if (deliveries && deliveries.length > 0) await writeOfficeDeliveries(tx, orderId, deliveries);
  if (await deliveryQuantitiesMissing(tx, orderId)) throwDeliveryQuantitiesMissing();
}
