import { formatQtySplit } from "@routeflow/pricing";

/**
 * units_v1 (step 5c-1): how the web reads an invoice line that was SOLD BY A UNIT (`unitLabel` set,
 * e.g. "Case"). Such a line is stored as `boxes = count`, `qty = count x factor` (base pieces),
 * `unitsPerBox = factor`, `unitLabel` (or, for a factor-1 unit, plain `qty = count` with no split).
 * A line with no `unitLabel` is the pack — every helper here returns exactly what the page showed
 * before, so a tenant without `flag.units_v1` (which can never hold a unit line) sees no change.
 */

interface UnitLabelled {
  unitLabel?: string | null;
}

/** True when the stored line is sold by a non-pack unit. */
export const isUnitLine = (it: UnitLabelled | null | undefined): boolean =>
  (it?.unitLabel ?? "").trim() !== "";

/** True when ANY of the invoice's lines is sold by a unit. */
export const hasUnitLine = (items: ReadonlyArray<UnitLabelled> | null | undefined): boolean =>
  !!items?.some(isUnitLine);

/** The distinct unit labels on an invoice, in line order ("Case", "Pallet"). */
export const unitLabelsOf = (items: ReadonlyArray<UnitLabelled> | null | undefined): string[] => [
  ...new Set((items ?? []).filter(isUnitLine).map((it) => (it.unitLabel as string).trim())),
];

/**
 * The quantity text of a stored invoice line. A pack line is EXACTLY `formatQtySplit` (byte-identical
 * to before). A unit line names its unit instead of "boxes": 3 Cases -> "3 Cases", not "3 boxes"
 * (the unit's pieces stay in the row's "864 pcs total" tooltip); a factor-1 unit has no split, so it
 * reads "5 Piece".
 */
export function invoiceLineQtyText(it: {
  qty: number | string;
  boxes?: number | null;
  pieces?: number | null;
  unitLabel?: string | null;
}): string {
  const split = { qty: it.qty, boxes: it.boxes, pieces: it.pieces };
  if (!isUnitLine(it)) return formatQtySplit(split);
  const label = (it.unitLabel as string).trim();
  if (it.boxes == null && it.pieces == null) return `${formatQtySplit(split)} ${label}`;
  return formatQtySplit({ ...split, boxLabel: label });
}
