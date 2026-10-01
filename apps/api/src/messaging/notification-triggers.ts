import { NotificationEvent } from "@prisma/client";
import type { NotificationAudience } from "@routeflow/types";

/** #1965 — the SINGLE registry of events that have a firing site (a `NotificationEvent.<KEY>`
 *  reference outside `messaging/`). `notification-triggers.spec.ts` walks the tree and fails if this
 *  set and reality diverge, so the notifications page can never show a switch for an event nothing
 *  fires. Add a key here in the same PR that adds its firing site (and to `DEFAULT_ON` if it is
 *  seeded on); never the other way round. */
export const NOTIFICATION_TRIGGERS: ReadonlySet<NotificationEvent> = new Set<NotificationEvent>([
  NotificationEvent.ORDER_CONFIRMED,
  NotificationEvent.OUT_FOR_DELIVERY,
  NotificationEvent.DELIVERED,
  NotificationEvent.CANCELLED,
  NotificationEvent.ORDER_CHANGED_AT_DOOR,
  NotificationEvent.INVOICE_SENT,
  NotificationEvent.LICENSE_EXPIRING,
]);

/** Who receives each event's message. The five INTERNAL-only alerts go to staff; every other
 *  event emails the buyer (customer). Exhaustive over `NotificationEvent` (compile-time). */
export const NOTIFICATION_AUDIENCE: Record<NotificationEvent, NotificationAudience> = {
  [NotificationEvent.ORDER_CONFIRMED]: "CUSTOMER",
  [NotificationEvent.OUT_FOR_DELIVERY]: "CUSTOMER",
  [NotificationEvent.DELIVERED]: "CUSTOMER",
  [NotificationEvent.CANCELLED]: "CUSTOMER",
  [NotificationEvent.ORDER_CHANGED_AT_DOOR]: "CUSTOMER",
  [NotificationEvent.INVOICE_SENT]: "CUSTOMER",
  [NotificationEvent.PAYMENT_REMINDER]: "CUSTOMER",
  [NotificationEvent.LICENSE_EXPIRING]: "CUSTOMER",
  [NotificationEvent.URGENT_ORDER_PLACED]: "STAFF",
  [NotificationEvent.LOW_STOCK]: "STAFF",
  [NotificationEvent.FAILED_DELIVERY]: "STAFF",
  [NotificationEvent.PAYMENT_FAILED_NSF]: "STAFF",
  [NotificationEvent.CHECK_RETURNED]: "STAFF",
};

export function notificationAudience(eventKey: NotificationEvent): NotificationAudience {
  return NOTIFICATION_AUDIENCE[eventKey];
}
