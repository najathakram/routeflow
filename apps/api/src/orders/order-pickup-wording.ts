import { NotificationEvent } from "@prisma/client";
import type { MessagingService, SendOutcome } from "../messaging/messaging.service";

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

/** The READY_FOR_PICKUP template's variables: ONE builder for the status-change path and the Ready button. */
function readyVars(order: { orderNumber?: string | null }, pickupLine: string) {
  // pickupLine: the template's optional address/hours tail (pickup-line.ts); "" never leaves the placeholder unfilled.
  return { orderNumber: order.orderNumber ?? "", pickupLine };
}

/**
 * A PICKUP order has no driver: never the driver-named OUT_FOR_DELIVERY template (the push says "ready for
 * pickup"). Its handover fires READY_FOR_PICKUP instead; the messaging path honours the customer's
 * orderStatusEmails opt-out, and a failure never fails the move. Returns whether it handled the change.
 * Fire-and-forget: PATCH :id/status and every older client keep this exactly (the Ready button awaits, below).
 * `onOutcomes` hears what the engine did (SA-1070: the PATCH path writes the same record the Ready press does).
 */
export function notifyPickupHandover(
  messaging: Pick<MessagingService, "notifyEvent">,
  order: { fulfillPath?: string | null; customerId: string; orderNumber?: string | null },
  status: string,
  senderId: string | null,
  onOutcomes?: (outcomes: SendOutcome[] | void) => unknown,
): boolean {
  if (!isPickupHandover(order, status)) return false;
  messaging
    .notifyEvent(NotificationEvent.READY_FOR_PICKUP, {
      customerId: order.customerId,
      senderId,
      vars: readyVars(order, ""),
    })
    .then((outcomes) => onOutcomes?.(outcomes))
    .catch(() => {});
  return true;
}

/** How long the Ready button waits on the email before it answers FAILED (the status has already committed). */
export const READY_EMAIL_TIMEOUT_MS = 15_000;

/**
 * The Ready button's sender (W-1043, SA-1062 MUST 17): the same READY_FOR_PICKUP event and variables as
 * `notifyPickupHandover`, but AWAITED, so the caller can tell staff what really happened. Never rejects: an engine
 * error or a hung send past `READY_EMAIL_TIMEOUT_MS` reads as a failed email.
 */
export async function sendPickupReady(
  messaging: Pick<MessagingService, "notify">,
  order: { customerId: string; orderNumber?: string | null },
  p: { senderId: string; customerName: string; pickupLine: string },
): Promise<SendOutcome[] | "FAILED"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      messaging.notify(NotificationEvent.READY_FOR_PICKUP, {
        customerId: order.customerId,
        senderId: p.senderId,
        vars: { ...readyVars(order, p.pickupLine), customerName: p.customerName },
      }),
      new Promise<"FAILED">((resolve) => {
        timer = setTimeout(() => resolve("FAILED"), READY_EMAIL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return "FAILED";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
