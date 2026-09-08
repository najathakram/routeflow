/**
 * B263 (B246 Option B) — pure price-override helper.
 *
 * cause-ruling.md §2 D2: centralises the price-override write both
 * `PriceOverrideModal` hosts (list branch + picker branch, D3) call —
 * `applyPriceOverride` rounds the typed price with `roundMoney` (money
 * discipline: CLAUDE.md "Round every monetary write") and stamps the
 * reason, leaving qty/box/free fields untouched; it never fabricates a
 * line total — the row's total is derived at render through
 * `computeLineSubtotal` with `draftFreeUnits(item)` (edit-items.tsx
 * `:1161`), which stays the single money path. `needsMarginAck` extracts
 * the existing below-floor ack check (edit-items.tsx `:1220` area) into a
 * pure function neither host has to duplicate.
 */
import { roundMoney } from "@routeflow/pricing";

/** Minimal shape both call sites need — matches the fields DraftItem exposes. */
export interface PriceOverrideItem {
  unitPrice: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  overrideReason?: string;
  [key: string]: unknown;
}

export interface PriceOverrideInput {
  unitPrice: number;
  reason?: string;
}

/**
 * Apply a typed price override to a draft item: round the new price to
 * cents (money discipline — never write an unrounded typed value) and
 * stamp the reason. Exactly those two fields are written; every other
 * field (qty, boxes, pieces, unitsPerBox, promo free units, ...)
 * round-trips unchanged — an override never touches how much was ordered,
 * and never invents a line total (the row's total is recomputed at render
 * through `computeLineSubtotal`).
 */
export function applyPriceOverride(
  item: PriceOverrideItem,
  input: PriceOverrideInput,
): PriceOverrideItem {
  return {
    ...item,
    unitPrice: roundMoney(input.unitPrice),
    overrideReason: input.reason,
  };
}

/**
 * Whether a typed price needs the below-floor "sell anyway" ack — true
 * when the new price sits strictly below the margin floor, false when it
 * meets or exceeds it. `floor` is a null-able price (unknown cost yields no
 * floor, so no ack is ever needed).
 */
export function needsMarginAck(
  _item: PriceOverrideItem,
  newPrice: number,
  floor: number | null | undefined,
): boolean {
  if (floor == null) return false;
  return newPrice < floor;
}
