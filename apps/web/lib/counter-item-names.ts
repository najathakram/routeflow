/**
 * R7b 2.1: the one-line "what was sold" text under a Today's-sales row, a parked row and the void dialog:
 * `Cola 12oz Can ×2, Ice Bag 10lb +1 more`. The names come from the server's row (`items` / `itemCount`, the invoice line
 * description snapshotted at sale time), never a live product name. Absent names -> null, so an older server's row shows
 * nothing (callers keep their own fallback).
 */
import { round4 } from "@routeflow/pricing";
import type { CounterItemName } from "@routeflow/types";

export const COUNTER_ROW_ITEM_NAMES = 2;

const qtyText = (qty: number): string => String(round4(qty));

export function itemNamesLine(
  items: readonly CounterItemName[] | null | undefined,
  itemCount?: number | null,
): string | null {
  if (!items || items.length === 0) return null;
  const shown = items.slice(0, COUNTER_ROW_ITEM_NAMES);
  const parts = shown.map((i) => {
    // a boxed or unit line reads in its selling unit ("×2 Cases"), as the receipt does; a plain qty of 1 stays bare
    const q = i.qtyText ?? (i.qty !== 1 && i.qty > 0 ? qtyText(i.qty) : null);
    return q ? `${i.name} ×${q}` : i.name;
  });
  const total = Math.max(itemCount ?? items.length, items.length);
  const more = total - shown.length;
  return more > 0 ? `${parts.join(", ")} +${more} more` : parts.join(", ");
}
