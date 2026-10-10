import { isShippedOrderStatus } from "@routeflow/types";

/**
 * The date a Shipments list row shows. `shippedAt` survives an "Unmark shipped" on purpose (the customer
 * is told once), so a row whose linked order is no longer shipped shows no date. No linked order
 * (a standalone invoice) keeps the date. Mirrors ShipmentCard's `orderStatus` rule.
 */
export function shipmentListShippedAt(inv: {
  shippedAt?: string | null;
  order?: { status?: string | null } | null;
}): string | null {
  if (!inv.shippedAt) return null;
  const status = inv.order?.status;
  return !status || isShippedOrderStatus(status) ? inv.shippedAt : null;
}
