/**
 * R7b 2.1: the one-line "what was sold" text under a Today's-sales row, a parked row and the void dialog:
 * `Cola 12oz Can ×2, Ice Bag 10lb +1 more`. The names come from the server's row (`items` / `itemCount`, the invoice line
 * description snapshotted at sale time), never a live product name. Absent names -> null, so an older server's row shows
 * nothing (callers keep their own fallback).
 */
export const COUNTER_ROW_ITEM_NAMES = 2;

export interface CounterItemName {
  name: string;
  qty: number;
}

const qtyText = (qty: number): string => String(Math.round(qty * 1000) / 1000);

export function itemNamesLine(
  items: readonly CounterItemName[] | null | undefined,
  itemCount?: number | null,
): string | null {
  if (!items || items.length === 0) return null;
  const shown = items.slice(0, COUNTER_ROW_ITEM_NAMES);
  const parts = shown.map((i) =>
    i.qty !== 1 && i.qty > 0 ? `${i.name} ×${qtyText(i.qty)}` : i.name,
  );
  const total = Math.max(itemCount ?? items.length, items.length);
  const more = total - shown.length;
  return more > 0 ? `${parts.join(", ")} +${more} more` : parts.join(", ");
}
