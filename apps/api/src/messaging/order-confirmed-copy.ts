/**
 * B1127 — wording of the "Order confirmed" email. Pure; no Prisma, no I/O.
 *
 * The old default read "...is confirmed for delivery on {{deliveryDate}}." and rendered "for delivery
 * on ." whenever the order had no requestedDeliveryDate, and said "delivery" for a carrier-shipped
 * order. The whole clause is now ONE variable, `{{deliveryClause}}`, so it can be empty without leaving
 * a dangling preposition (the same device as `{{trackingLine}}` / `{{pickupLine}}`):
 *
 *   SHIP order                      -> " and will ship by carrier"   (no delivery-date wording at all)
 *   ROUTE order with a date         -> " for delivery on <date>"     (the sentence as it always was)
 *   ROUTE order without a date,
 *   or a PICKUP order               -> ""                            ("...is confirmed.")
 *
 * `{{deliveryDate}}` and `{{orderTotal}}` stay supplied exactly as before, so a business's own
 * (customised) template keeps rendering as it wrote it.
 */
import { FulfillPath, NotificationEvent } from "@prisma/client";
import { formatDate, formatMoney } from "./messaging.helpers";

/** The ORDER_CONFIRMED default body every tenant seeded before B1127 still has stored. */
export const LEGACY_ORDER_CONFIRMED_BODY =
  "Hi {{customerName}}, your order {{orderNumber}} is confirmed for delivery on {{deliveryDate}}. Total: {{orderTotal}}.";

/** Template variables for ORDER_CONFIRMED. `total` is the STORED order total (no money math here). */
export function orderConfirmedVars(
  order: { fulfillPath?: FulfillPath | null; requestedDeliveryDate?: Date | string | null },
  total: unknown,
): { deliveryDate: string; orderTotal: string; deliveryClause: string } {
  const deliveryDate = formatDate(order.requestedDeliveryDate);
  const path = order.fulfillPath ?? FulfillPath.ROUTE;
  const deliveryClause =
    path === FulfillPath.SHIP
      ? " and will ship by carrier"
      : path === FulfillPath.ROUTE && deliveryDate
        ? ` for delivery on ${deliveryDate}`
        : "";
  return { deliveryDate, orderTotal: formatMoney(total), deliveryClause };
}

/** Pre-change DEFAULT bodies, per event. A stored body that EQUALS one (whitespace-trimmed) was never
 *  edited by the business, so it is the shipped default of its day, not their wording. */
const LEGACY_DEFAULT_BODIES: Partial<Record<NotificationEvent, readonly string[]>> = {
  [NotificationEvent.ORDER_CONFIRMED]: [LEGACY_ORDER_CONFIRMED_BODY],
};

/**
 * The body to render/show for a stored template: the CURRENT default when the stored text is exactly a
 * superseded default, otherwise the stored text untouched. Needed because `MessageTemplate` rows are
 * per-tenant copies seeded once (`seedDefaultsFor` skips an existing row), so changing
 * `DEFAULT_TEMPLATES` alone never reaches a tenant that already has the row. Any edit by the business,
 * even a single character, makes the body theirs and it is never rewritten.
 */
export function upgradeLegacyDefaultBody(
  eventKey: NotificationEvent,
  storedBody: string,
  currentDefault: string,
): string {
  return LEGACY_DEFAULT_BODIES[eventKey]?.includes(storedBody.trim()) ? currentDefault : storedBody;
}
