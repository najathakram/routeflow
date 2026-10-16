/**
 * B1234 (owner ruling 2026-10-03, D-O2-a): on a PARTIALLY_DELIVERED order a line that has been delivered
 * (deliveredQty > 0) is locked. The server refuses any edit of it (409 ORDER_LINE_DELIVERED_LOCKED); this is
 * the screen's mirror of the SAME predicate (apps/api/src/orders/delivered-line-lock.ts), so the edit builder
 * never offers a control the API will refuse. Pure; every other status returns "not locked".
 */
const LOCK_STATUSES: readonly string[] = ["PARTIALLY_DELIVERED"];

export const DELIVERED_LINE_LOCK_HINT =
  "Delivered. This line can't be changed or removed. Add a note if needed.";

/** True when `line` is a delivered line of an order whose status locks delivered lines. */
export function isLineDeliveredLocked(
  orderStatus: string | null | undefined,
  line: { deliveredQty?: number | string | null },
): boolean {
  return !!orderStatus && LOCK_STATUSES.includes(orderStatus) && Number(line.deliveredQty ?? 0) > 0;
}

/** The ids of the order's locked lines, for the edit builder. */
export function deliveredLockedLineIds(
  orderStatus: string | null | undefined,
  lines: ReadonlyArray<{ id: string; deliveredQty?: number | string | null }>,
): Set<string> {
  return new Set(lines.filter((l) => isLineDeliveredLocked(orderStatus, l)).map((l) => l.id));
}
