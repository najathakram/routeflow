/**
 * `shippedAt` survives an "Unmark shipped" on purpose (the customer is told once), so the "Shipped
 * <date>" row shows only while the linked order is actually shipped. Pure so it is Jest-testable.
 * Mirrors apps/web/components/ShipmentCard.tsx (`orderStatus`).
 */
import { isShippedOrderStatus } from "@routeflow/types";
import { notShippedNote } from "@routeflow/types/shipment-save";

/** The shipment with `shippedAt` dropped when the order is no longer shipped. No order status
 *  (a standalone invoice) leaves it untouched. */
export function shipmentForDisplay<T extends { shippedAt?: string | null }>(
  shipment: T,
  orderStatus: string | null | undefined,
): T {
  if (!orderStatus || isShippedOrderStatus(orderStatus)) return shipment;
  return { ...shipment, shippedAt: null };
}

/**
 * Saved tracking on a carrier (SHIP) order that has not shipped: saving tracking never ships the
 * order, "Mark shipped" does. Null once shipped or cancelled, off a SHIP order, or with no tracking.
 * The wording is shared with web (`notShippedNote`); mobile has no notification setting to read, so it
 * never claims the customer is told.
 */
export function shipmentNotShippedNote(
  fulfillPath: string | null | undefined,
  orderStatus: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (fulfillPath !== "SHIP" || !orderStatus || !trackingNumber?.trim()) return null;
  if (isShippedOrderStatus(orderStatus) || orderStatus === "CANCELLED") return null;
  return notShippedNote(false);
}
