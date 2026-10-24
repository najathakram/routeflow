// Order statuses at/after "marked shipped" (OrderStatus has no SHIPPED): out for delivery, part
// delivered, delivered. Web and mobile read this to show the "Shipped <date>" only while an order is
// actually shipped (`shippedAt` survives an unmark). The api keeps its own literal
// (`apps/api/src/orders/shipment-notifications.ts` SHIPPED_STATUSES: it cannot value-import this
// package), pinned set-equal by `apps/api/src/orders/shipped-statuses-parity.spec.ts` (L-072).
export const SHIPPED_ORDER_STATUSES = [
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
] as const;

export type ShippedOrderStatus = (typeof SHIPPED_ORDER_STATUSES)[number];

export const isShippedOrderStatus = (status: string | null | undefined): boolean =>
  !!status && (SHIPPED_ORDER_STATUSES as readonly string[]).includes(status);
