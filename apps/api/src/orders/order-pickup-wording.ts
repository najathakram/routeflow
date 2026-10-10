import { NotificationEvent } from "@prisma/client";
import type { MessagingService } from "../messaging/messaging.service";

/**
 * SA-655: a PICKUP (counter) order is handed over at the till, so its OUT_FOR_DELIVERY change must not
 * say "on its way" or name a driver. Returns the push to send instead, or null for any other order.
 */
export function pickupOutForDeliveryPush(order: {
  fulfillPath?: string | null;
  orderNumber?: string | null;
}): { title: string; body: string } | null {
  if (order.fulfillPath !== "PICKUP") return null;
  return {
    title: "Ready for pickup",
    body: `Your order #${order.orderNumber} is ready for pickup.`,
  };
}

/** True when this status change is a PICKUP order's OUT_FOR_DELIVERY (no driver exists to name). */
export function isPickupHandover(order: { fulfillPath?: string | null }, status: string): boolean {
  return order.fulfillPath === "PICKUP" && status === "OUT_FOR_DELIVERY";
}

/**
 * A PICKUP order has no driver: never the driver-named OUT_FOR_DELIVERY template (the push says "ready for
 * pickup"). Its handover fires READY_FOR_PICKUP instead; the messaging path honours the customer's
 * orderStatusEmails opt-out, and a failure never fails the move. Returns whether it handled the change.
 */
export function notifyPickupHandover(
  messaging: Pick<MessagingService, "notifyEvent">,
  order: { fulfillPath?: string | null; customerId: string; orderNumber?: string | null },
  status: string,
  senderId: string | null,
): boolean {
  if (!isPickupHandover(order, status)) return false;
  messaging
    .notifyEvent(NotificationEvent.READY_FOR_PICKUP, {
      customerId: order.customerId,
      senderId,
      // pickupLine: the template's optional address/hours tail; "" until the pickup settings feed it
      // (never leave the placeholder unfilled).
      vars: { orderNumber: order.orderNumber ?? "", pickupLine: "" },
    })
    .catch(() => {});
  return true;
}
