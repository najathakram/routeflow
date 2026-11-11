/**
 * W-1187 (SA ruling D5, D11): `PUT /orders/:id/line-order` (staff) and `PUT /buyer/orders/:id/line-order` (the buyer, while
 * the edit window is open) put an order's lines in the order the caller arranged them.
 *
 * `lineIds` is EVERY line of the order (cancelled and staff-added rows included), in the new order; the server refuses a
 * missing, extra, duplicated or foreign id with 409 ORDER_CHANGED_DURING_EDIT (the client refetches), and a stale
 * `expectedUpdatedAt` the same way. The API keeps an equal copy of `LINE_ORDER_MAX_IDS` (it never value-imports this package
 * at runtime); `apps/api/src/orders/dto/reorder-lines.dto.spec.ts` pins the two.
 */

/** Above any real order: it bounds the payload. */
export const LINE_ORDER_MAX_IDS = 1000;

/** The modes of a server-side sort ("Sort A to Z"); one more mode is one more value and one more comparator. The API keeps an equal copy (`reorder-lines.dto.ts`), pinned by `reorder-lines.dto.spec.ts`. */
export const LINE_SORT_VALUES = ["name"] as const;
export type LineSort = (typeof LINE_SORT_VALUES)[number];

/** Exactly one of `lineIds` (the caller arranged them) or `sort` (the server arranges them, once; never a stored view mode). */
export type ReorderLinesRequest = {
  /** The order's `updatedAt` as the client read it; a different value is a 409. */
  expectedUpdatedAt: string;
} & ({ lineIds: string[]; sort?: never } | { sort: LineSort; lineIds?: never });

/** Who last rearranged an order's lines, from the audit row; staff-only on the order read. */
export interface LinesRearranged {
  by: "CUSTOMER" | "STAFF";
  at: string;
}

export interface ReorderLinesResponse {
  id: string;
  /** The new CAS token: the next reorder sends this. */
  updatedAt: string;
  /** Every line id in the new order. */
  lineIds: string[];
  linesRearranged: LinesRearranged;
}
