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
