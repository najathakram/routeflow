/**
 * Marker revisions that tell a deliberate UNMARK from a REOPEN after delivery (there is no order status
 * history table, and `shippedAt` survives both, by design: E-c's "no second shipped email").
 *
 * For a carrier (SHIP) order, `changeStatus` appends one `OrderRevision` with a marker `source` on:
 *  - OUT_FOR_DELIVERY -> CONFIRMED ("Unmark shipped"): the parcel never left, so a later cancel is fine;
 *  - DELIVERED -> CONFIRMED / PARTIALLY_DELIVERED (a reopen): the goods went out, so the order is
 *    "with the carrier" again and is not cancelled (`carrierCancelBlockedReason`).
 * The LAST marker decides. `OrderRevision.source` is a free string (not a Prisma enum): no migration.
 */
import { FulfillPath, OrderStatus } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";
import { appendOrderRevision } from "./order-revisions";

export const SHIP_STATE_UNMARKED = "UNMARKED_SHIPPED";
export const SHIP_STATE_REOPENED = "REOPENED_FROM_DELIVERY";

/** The marker a status change leaves (SHIP orders only), or null when it is not one. */
export function shipStateMarker(
  fulfillPath: FulfillPath,
  from: OrderStatus,
  to: OrderStatus,
): string | null {
  if (fulfillPath !== FulfillPath.SHIP) return null;
  if (from === OrderStatus.OUT_FOR_DELIVERY && to === OrderStatus.CONFIRMED)
    return SHIP_STATE_UNMARKED;
  if (
    from === OrderStatus.DELIVERED &&
    (to === OrderStatus.CONFIRMED || to === OrderStatus.PARTIALLY_DELIVERED)
  ) {
    return SHIP_STATE_REOPENED;
  }
  return null;
}

/** Record the marker for this status change, if it is one. Never throws: the status write is done. */
export async function recordShipStateChange(
  prisma: PrismaService,
  order: {
    id: string;
    status: OrderStatus;
    fulfillPath: FulfillPath;
    subtotal: unknown;
    tax: unknown;
    total: unknown;
  },
  to: OrderStatus,
  user: JwtPayload | undefined,
  reason?: string | null,
): Promise<void> {
  const source = shipStateMarker(order.fulfillPath, order.status, to);
  if (!source) return;
  try {
    await appendOrderRevision(
      prisma,
      order.id,
      user,
      { subtotal: Number(order.subtotal), tax: Number(order.tax), total: Number(order.total) },
      source,
      reason,
    );
  } catch {
    // best effort: a missing marker reads as "unmarked" (cancellable), never as a failed status change
  }
}

/** The source of the LAST ship-state marker on the order, or null when there is none. */
export async function lastShipStateSource(
  prisma: Pick<PrismaService, "forTenant">,
  orderId: string,
): Promise<string | null> {
  const row = await prisma.forTenant().orderRevision.findFirst({
    where: { orderId, source: { in: [SHIP_STATE_UNMARKED, SHIP_STATE_REOPENED] } },
    orderBy: { revisionNumber: "desc" },
    select: { source: true },
  });
  return row?.source ?? null;
}
