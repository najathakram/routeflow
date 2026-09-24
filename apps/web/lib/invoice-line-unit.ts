import { invoiceLineQtyText } from "@routeflow/pricing";

/** The ONE qty-text formatter — web, api (PDF + email) and mobile all call this same
 *  function from @routeflow/pricing (B653 review: no second copy of the decision). */
export { invoiceLineQtyText };

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
