// B1083: why the server will not cancel (or delete, or reduce) an order, if it will not. The web reads
// this off the order read to hide the Cancel action; it never derives it from the status.

/** "WITH_CARRIER": a carrier (SHIP) order whose parcel is with the carrier; it goes through a return. */
export type OrderCancelBlockedReason = "WITH_CARRIER";

/** The field `GET /orders/:id` adds to the order. */
export interface OrderCancelBlockedField {
  cancelBlockedReason: OrderCancelBlockedReason | null;
}
