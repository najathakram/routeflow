/**
 * `shippedAt` survives an "Unmark shipped" on purpose (the customer is told once), so the "Shipped
 * <date>" row shows only while the linked order is actually shipped. Pure so it is Jest-testable.
 * Mirrors apps/web/components/ShipmentCard.tsx (`orderStatus`).
 */
import { isShippedOrderStatus } from "@routeflow/types";

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
 * What a shipment save did, so the toast tells the truth (M8): saving a carrier or tracking number is
 * "saved"; blanking a stored shipment is "cleared"; saving blank over nothing changes nothing, so it
 * is "nothing" (the caller closes the modal without a request or a toast). Mirrors apps/web
 * `ShipmentCard`.
 */
export function shipmentSaveOutcome(
  stored: { shippingCarrier?: string | null; shippingTrackingNumber?: string | null },
  carrier: string,
  trackingNumber: string,
): "saved" | "cleared" | "nothing" {
  if (carrier.trim() || trackingNumber.trim()) return "saved";
  const hadStored = !!(stored.shippingCarrier?.trim() || stored.shippingTrackingNumber?.trim());
  return hadStored ? "cleared" : "nothing";
}

/**
 * Saved tracking on a carrier (SHIP) order that has not shipped: saving tracking never ships the
 * order, "Mark shipped" does. Null once shipped or cancelled, off a SHIP order, or with no tracking.
 * Mirrors apps/web `ShipmentCard`.
 */
export function shipmentNotShippedNote(
  fulfillPath: string | null | undefined,
  orderStatus: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (fulfillPath !== "SHIP" || !orderStatus || !trackingNumber?.trim()) return null;
  if (isShippedOrderStatus(orderStatus) || orderStatus === "CANCELLED") return null;
  return "Not shipped yet. The customer is told when you mark the order shipped.";
}
