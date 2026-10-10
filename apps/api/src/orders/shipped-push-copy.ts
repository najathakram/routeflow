/**
 * The customer PUSH for a carrier (SHIP) order that was just marked shipped. "Out for Delivery" is
 * wrong for a parcel, so it reuses the ORDER_SHIPPED email wording ("has shipped with <carrier>" plus
 * the tracking line when the order already has it) via `shipmentVars`. ROUTE orders keep their push;
 * PICKUP wording belongs to #3211 and is not touched here.
 */
import { shipmentVars } from "./shipment-notifications";

export function shippedPushCopy(order: {
  orderNumber: string | null;
  shippingCarrier: string | null;
  shippingTrackingNumber: string | null;
}): { title: string; body: string } {
  const ship = shipmentVars(order);
  return {
    title: "Order shipped",
    body: `Your order #${order.orderNumber} has shipped with ${ship.carrier}.${ship.trackingLine}`,
  };
}
