/**
 * Row 590 (SA-978a): the fixed copy of an office DELIVERED on an order whose run stop has not completed. The api sends
 * the same sentence in the 409 body; it keeps a literal copy (it never value-imports this package at runtime), pinned
 * byte-equal by apps/api/src/common/order-route-stop-copy-parity.spec.ts. Pure.
 */
export const ORDER_DELIVERED_ON_ROUTE_STOP_COPY =
  "This order is on a delivery run. Complete its stop on the route, or take it off the run first.";
