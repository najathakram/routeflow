/**
 * The ship-state marker constants: a LEAF module (it imports nothing from `orders/`), so both
 * `order-ship-state.ts` (writes and reads the markers) and `order-status-invoicing.ts` (the cancel guard
 * reads the last one) can import them without importing each other (SA-689 b).
 *
 * `OrderRevision.source` is a free string (not a Prisma enum): these are its two marker values. The story
 * of what they mean lives in `order-ship-state.ts`.
 */
export const SHIP_STATE_UNMARKED = "UNMARKED_SHIPPED";
export const SHIP_STATE_REOPENED = "REOPENED_FROM_DELIVERY";
export const SHIP_STATE_SOURCES: string[] = [SHIP_STATE_UNMARKED, SHIP_STATE_REOPENED];
/** `findOne`'s revisions include: the order's edit history, without the markers. */
export const EDIT_REVISIONS = {
  where: { source: { notIn: SHIP_STATE_SOURCES } },
  orderBy: { revisionNumber: "asc" as const },
};
