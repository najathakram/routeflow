/**
 * B784 — mobile mirror of apps/web/lib/invoice-line-unit.ts's isUnitLine/hasUnitLine/
 * unitLabelsOf. Web's invoice edit page already fails closed on a unit-aware invoice
 * (B641, edit/page.tsx:591-610) before InvoicesService.update()'s own
 * assertInvoiceRewriteAllowed (409 UNIT_AWARE_LINE) is ever reached — mobile's edit
 * screen had no such up-front guard, so an operator only learned from the 409 on Save.
 * RN can't import a web component, so this tiny pure logic is duplicated rather than
 * shared (same reasoning as invoice-line-display.ts).
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
