import {
  OPERATOR_CORRECT_NOTE,
  fillLockedCopy,
  type LineEditModeFields,
  type LineLockedReason,
} from "@routeflow/types";

/**
 * SA-1506 PR-1a: what the edit builder does with a DELIVERED line is the SERVER's answer, carried on every staff line read
 * (`lineEditMode`, decided by `deliveredLineEditMode` in apps/api/src/orders/delivered-line-edit-mode.ts). This file only
 * reads it (L-072: no second rule on the screen):
 *  - LOCKED: no editing control, the line's sentence says why and names the step that exists;
 *  - CORRECT (an admin): the controls stay (quantity, box split, price, take off) with the correction note; never a swap;
 *  - EDIT: an ordinary line.
 * A response without the field (an older server) falls back to B1234's rule: PARTIALLY_DELIVERED + delivered = locked.
 */
const LEGACY_LOCK_STATUSES: readonly string[] = ["PARTIALLY_DELIVERED"];

/** The B1234 sentence, kept for a line the server locks for ROLE with nothing an admin could do (and an older server). */
export const DELIVERED_LINE_LOCK_HINT =
  "Delivered. This line can't be changed or removed. Add a note if needed.";

/** SA-1408 item 1 (SA-1415): the note on a line an admin may correct. */
export const correctableLineNote = (qty: number | string, unit?: string | null): string =>
  `Delivered: ${qty}${unit ? ` ${unit}` : ""}. Changing this corrects what was delivered. Stock and the invoice update. If goods came back, use Return.`;

/** SA-1408 item 2 (SA-1415): the take-off confirm. */
export const takeOffTitle = (item: string): string =>
  `Take ${item.trim() || "this item"} off this order?`;
export const TAKE_OFF_BODY =
  "It was marked delivered. Stock goes back on the shelf, and the invoice goes down. If the customer sent it back, use Return instead.";

/** After a save that corrected a delivered line. */
export const CORRECTED_SAVED_TITLE = "Saved. Delivered items corrected.";

type ModeLine = {
  id?: string;
  deliveredQty?: number | string | null;
} & Partial<LineEditModeFields>;

/** True when `line` is a delivered line the screen must not offer controls for. */
export function isLineDeliveredLocked(
  orderStatus: string | null | undefined,
  line: ModeLine,
): boolean {
  if (line.lineEditMode !== undefined) return line.lineEditMode === "LOCKED";
  return (
    !!orderStatus &&
    LEGACY_LOCK_STATUSES.includes(orderStatus) &&
    Number(line.deliveredQty ?? 0) > 0
  );
}

/** An admin may correct this delivered line (the server said CORRECT). */
export const isLineCorrectable = (line: Partial<LineEditModeFields>): boolean =>
  line.lineEditMode === "CORRECT";

/** The ids of the order's locked lines, for the edit builder. */
export function deliveredLockedLineIds(
  orderStatus: string | null | undefined,
  lines: ReadonlyArray<ModeLine>,
): Set<string> {
  return new Set(
    lines.filter((l) => isLineDeliveredLocked(orderStatus, l)).map((l) => l.id as string),
  );
}

/** The sentence under a locked line: the server's reason, worded in one place (`fillLockedCopy`). */
export function lockedLineHint(
  line: Partial<LineEditModeFields>,
  itemName?: string | null,
): string {
  const reason: LineLockedReason | null | undefined = line.lockedReason;
  if (!reason) return DELIVERED_LINE_LOCK_HINT;
  if (reason === "ROLE")
    return line.lockedOperatorNote
      ? `Delivered. ${OPERATOR_CORRECT_NOTE}`
      : DELIVERED_LINE_LOCK_HINT;
  return fillLockedCopy(reason, {
    item: itemName,
    invoiceNumber: line.lockedInvoiceNumber,
    status: line.lockedStatus,
  });
}

/**
 * The toast after a save: names a correction when the edit touched (changed or took off) a delivered line the server
 * said an admin may correct. `order.lineItems` are the lines as loaded, `pendingDeletes` the removed ones.
 */
export function savedTitle(
  order: { lineItems: ReadonlyArray<ModeLine> },
  items: ReadonlyArray<{
    id: string;
    correctable?: boolean;
    qty: number;
    originalQty: number;
    cancelled: boolean;
  }>,
  pendingDeletes: ReadonlyArray<string>,
): string {
  const correctable = new Set(order.lineItems.filter(isLineCorrectable).map((l) => l.id as string));
  const touched =
    pendingDeletes.some((id) => correctable.has(id)) ||
    items.some((it) => correctable.has(it.id) && (it.cancelled || it.qty !== it.originalQty));
  return touched ? CORRECTED_SAVED_TITLE : "Order updated";
}
