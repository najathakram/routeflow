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
  /** Row 380: the revision the client read; a stale one is 409 `ORDER_REVISION_STALE`. */
  expectedRevisionNumber?: number;
}

/**
 * SA-1149: a buyer's full-list save on an order that already has a delivered line is refused 409
 * `ORDER_EDIT_DELIVERED_LINES`. The sentence the buyer reads, stored once: the web portal and the mobile buyer edit both
 * show it instead of the server's staff wording. (The mobile jest stub holds a byte-identical hand copy, pinned equal.)
 */
export const BUYER_EDIT_DELIVERED_LINES_COPY =
  "Part of this order was already delivered, so it can't be changed here. Contact the seller to change it.";

/**
 * SA-1161: the ONE list of what a buyer edit may carry, for the server's allowlist (`assertBuyerEditInput`) and the
 * clients. Each list is held equal to its interface below, so a new field cannot be added to one and not the other.
 */
export const BUYER_EDIT_ENTRY_FIELDS = ["productId", "qty", "orderItemId"] as const;
export const BUYER_EDIT_BODY_FIELDS = ["items", "namesLines", "expectedRevisionNumber"] as const;

type SameKeys<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const entryFieldsInSync: SameKeys<
  keyof BuyerOrderItemEdit,
  (typeof BUYER_EDIT_ENTRY_FIELDS)[number]
> = true;
const bodyFieldsInSync: SameKeys<
  keyof BuyerUpdateOrderItemsRequest,
  (typeof BUYER_EDIT_BODY_FIELDS)[number]
> = true;
/** Compile-time proof only: this assignment fails the build if a list and its interface drift. */
export const BUYER_EDIT_LISTS_IN_SYNC: readonly [true, true] = [
  entryFieldsInSync,
  bodyFieldsInSync,
];
