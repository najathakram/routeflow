/**
 * Customer emails for CARRIER-shipped orders (fulfillPath SHIP). "Mark shipped" is the
 * CONFIRMED -> OUT_FOR_DELIVERY transition (OrderStatus has no SHIPPED), and the old
 * OUT_FOR_DELIVERY copy ("out for delivery today with <carrier>") is wrong for a parcel.
 *
 *  - `notifyOrderShipped`: fires ORDER_SHIPPED instead of OUT_FOR_DELIVERY for a SHIP order, for every
 *    business. A business that CUSTOMISED its OUT_FOR_DELIVERY wording keeps it: per CHANNEL, the
 *    channels whose enabled OUT_FOR_DELIVERY template differs from the shipped default still get
 *    OUT_FOR_DELIVERY (now with the carrier / tracking vars available), every other channel gets
 *    ORDER_SHIPPED, and no channel ever gets both.
 *  - `notifyTrackingAdded`: ONE follow-up SHIPMENT_TRACKING_ADDED the first time tracking is added to an
 *    order that is already shipped. `Order.trackingNotifiedAt` is claimed atomically (updateMany where
 *    NULL), so a double submit, a later edit, or clear-then-re-add can never send a second one. The same
 *    marker is stamped when tracking already went out inside the ORDER_SHIPPED email.
 *
 * The firing sites live here (outside `messaging/`) so default-on-is-wired / notification-triggers see them.
 * Both helpers NEVER throw: a notification failure must not fail the status / shipment write.
 */
import { Logger } from "@nestjs/common";
import { NotificationEvent, OrderStatus } from "@prisma/client";
import { carrierLabel, getTrackingUrl } from "../common/shipping";
import type { MessagingService } from "../messaging/messaging.service";
import type { PrismaService } from "../prisma/prisma.service";

const logger = new Logger("ShipmentNotifications");

/** Statuses at/after "marked shipped" for a SHIP order (CANCELLED is not shipped). */
export const SHIPPED_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
]);

export interface ShipmentNotifyOrder {
  id: string;
  customerId: string;
  orderNumber: string | null;
  shippingCarrier: string | null;
  shippingTrackingNumber: string | null;
}

interface Deps {
  prisma: PrismaService;
  messaging: MessagingService;
}

/** Template variables for the carrier / tracking. Pure. */
export function shipmentVars(order: {
  shippingCarrier: string | null;
  shippingTrackingNumber: string | null;
}): { carrier: string; trackingNumber: string; trackingUrl: string; trackingLine: string } {
  const carrier = carrierLabel(order.shippingCarrier) || "the carrier";
  const trackingNumber = (order.shippingTrackingNumber ?? "").trim();
  const url = getTrackingUrl(order.shippingCarrier, trackingNumber);
  return {
    carrier,
    trackingNumber,
    // Unknown carrier => no link; never render a dangling "<number> — ".
    trackingUrl: url ?? `via ${carrier}`,
    trackingLine: trackingNumber ? ` Tracking: ${trackingNumber}${url ? ` — ${url}` : ""}` : "",
  };
}

/** Atomically claim the one-time tracking marker; true only for the caller that set it. */
async function claimTrackingMarker(prisma: PrismaService, orderId: string): Promise<boolean> {
  const res = await prisma.forTenant().order.updateMany({
    where: { id: orderId, trackingNotifiedAt: null },
    data: { trackingNotifiedAt: new Date() },
  });
  return res.count === 1;
}

/** SHIP order just marked shipped (CONFIRMED -> OUT_FOR_DELIVERY). */
export async function notifyOrderShipped(
  deps: Deps,
  order: ShipmentNotifyOrder,
  senderId: string | null,
): Promise<void> {
  try {
    const ship = shipmentVars(order);
    const orderNumber = order.orderNumber ?? "";
    const custom = await deps.messaging.customisedChannels(NotificationEvent.OUT_FOR_DELIVERY);
    if (custom.length > 0) {
      await deps.messaging.notifyEvent(NotificationEvent.OUT_FOR_DELIVERY, {
        customerId: order.customerId,
        senderId,
        channels: custom,
        vars: { orderNumber, driverName: ship.carrier, ...ship },
      });
    }
    await deps.messaging.notifyEvent(NotificationEvent.ORDER_SHIPPED, {
      customerId: order.customerId,
      senderId,
      ...(custom.length > 0 ? { exceptChannels: custom } : {}),
      vars: { orderNumber, carrier: ship.carrier, trackingLine: ship.trackingLine },
    });
    // Tracking already went out with the shipped email: it is not "added after shipped" later.
    if (ship.trackingNumber) await claimTrackingMarker(deps.prisma, order.id);
  } catch (err) {
    logger.warn(`notifyOrderShipped failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Tracking just went empty -> set on an already-shipped SHIP order: send the follow-up once. */
export async function notifyTrackingAdded(
  deps: Deps,
  order: ShipmentNotifyOrder,
  senderId: string | null,
): Promise<void> {
  try {
    if (!(await claimTrackingMarker(deps.prisma, order.id))) return;
    const ship = shipmentVars(order);
    await deps.messaging.notifyEvent(NotificationEvent.SHIPMENT_TRACKING_ADDED, {
      customerId: order.customerId,
      senderId,
      vars: {
        orderNumber: order.orderNumber ?? "",
        trackingNumber: ship.trackingNumber,
        trackingUrl: ship.trackingUrl,
      },
    });
  } catch (err) {
    logger.warn(`notifyTrackingAdded failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** E-c: the customer hears "shipped" once. `shippedAt` is stamped by the ship transition and survives
 *  an unmark, so a re-ship of the same order is not a first shipment. */
export const isFirstShipment = (order: { shippedAt?: Date | null }): boolean => !order.shippedAt;
