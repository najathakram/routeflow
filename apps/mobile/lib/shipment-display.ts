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
