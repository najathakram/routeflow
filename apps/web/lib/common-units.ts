/**
 * Common unit suggestions for the product unit fields. ONE list: UnitCombobox (create flows) and the
 * product edit page both import it (they used to declare their own, 23 vs 19 entries).
 */
export const COMMON_UNITS: readonly string[] = [
  "each",
  "unit",
  "pcs",
  "case",
  "box",
  "bag",
  "pack",
  "dozen",
  "bundle",
  "tray",
  "pallet",
  "kg",
  "g",
  "lb",
  "oz",
  "L",
  "ml",
  "liter",
  "roll",
  "sheet",
  "bottle",
  "can",
  "strip",
];

/**
 * Settings > Units "Common units" chips (U-1): the first-run subset, in the order shown. COMMON_UNITS
 * above is unchanged. Names are shown and added exactly as written here.
 */
export const UNIT_CHIPS: readonly string[] = [
  "Case",
  "Box",
  "Pack",
  "Bag",
  "Dozen",
  "Tray",
  "Pallet",
  "Bottle",
  "Can",
];

/** Words for the smallest unit: Piece is always there, so these are never offered as chips. */
export const PIECE_SYNONYMS: readonly string[] = ["each", "unit", "pcs"];

/** Measures keep their own casing (kg, L, ml) and sit behind the chips' "More" button. */
const MEASURES: readonly string[] = ["kg", "g", "lb", "oz", "L", "ml"];

const shown = (u: string) => (MEASURES.includes(u) ? u : u.charAt(0).toUpperCase() + u.slice(1));

/** Everything else in COMMON_UNITS (bundle, roll, sheet, strip, liter and the measures), for "More". */
export const MORE_UNIT_CHIPS: readonly string[] = COMMON_UNITS.filter(
  (u) =>
    !PIECE_SYNONYMS.includes(u) && !UNIT_CHIPS.some((c) => c.toLowerCase() === u.toLowerCase()),
).map(shown);
