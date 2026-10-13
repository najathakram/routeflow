// ─── Buyer order items edit — PATCH /buyer/orders/:id/items ─────────────────────
//
// B297 row 352 (SA-734r2 r-note 4): each entry names the stored line it edits. After a rate change the same
// product can sit on two lines sold at different excise rates, so the product alone no longer identifies a
// line, and an entry that does not name one is a NEW line stamped at today's rate. Mirrors
// `UpdateOrderItemDto` (apps/api/src/orders/dto/update-order-items.dto.ts) for the fields a buyer sends.
//
//  - `orderItemId` set: that line of this order (another order's id, or another product's, is a 400);
//  - unset: a new line. For ONE release the server still treats an id-less entry as the product's only line
//    when exactly one exists, and answers 409 `ORDER_EDIT_NEEDS_LINE_IDS` ("Refresh and try again") when two
//    or more could be meant — a client that always sends the id never meets either.

export interface BuyerOrderItemEdit {
  productId: string;
  qty: number;
  orderItemId?: string;
}

export interface BuyerUpdateOrderItemsRequest {
  items: BuyerOrderItemEdit[];
  /**
   * The client names EVERY existing line it edits with `orderItemId`: an entry without one is a new line.
   * Send `true` always; omitting it is the legacy contract (the one-release product fallback above).
   */
  namesLines?: boolean;
}
