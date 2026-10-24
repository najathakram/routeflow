// B1083: why the server will not cancel (or delete, or reduce) an order, if it will not. The web reads
// this off the order read to hide the Cancel action; it never derives it from the status.

/** "WITH_CARRIER": a carrier (SHIP) order whose parcel is with the carrier; it goes through a return. */
export type OrderCancelBlockedReason = "WITH_CARRIER";

/** The field `GET /orders/:id` adds to the order. */
export interface OrderCancelBlockedField {
  cancelBlockedReason: OrderCancelBlockedReason | null;
}

/**
 * Row 673 (SA-831b M6): the field `GET /orders/:id` adds for the fulfil-path switch. true = the server refuses
 * `PATCH /orders/:id/fulfill-path` (shipped / Ready for pickup, delivered, cancelled), so "Switch to delivery" and "Ship
 * by carrier…" are not offered. A client reads this; it never re-derives it from the status.
 */
export interface OrderFulfillPathLockField {
  fulfillPathLocked: boolean;
}
