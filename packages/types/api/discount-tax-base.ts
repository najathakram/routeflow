// ─── Invoice-level discount tax base (SA-1141 / W-989) — the wire field's union ───────────────────────────────────
//
// The invoice, order and estimate detail responses carry `discountTaxBase`: where the document's whole-invoice discount sat
// relative to sales tax when it was written. The server derives it (`discountModeOf`, a pure function of the document's source
// `createdAt` against one cutover constant, never a client clock); the web footers branch on it so a preview equals the saved
// document. The same two values as `DiscountTaxBase` in @routeflow/pricing, pinned by `discount-tax-base-parity.spec.ts`.

export const DISCOUNT_TAX_BASE_VALUES = ["PRE_TAX", "LEGACY_POST_TAX"] as const;
export type DiscountTaxBaseValue = (typeof DISCOUNT_TAX_BASE_VALUES)[number];

/** Mixed into the invoice, order and estimate detail types. Absent on an older server's response: read it as LEGACY. */
export interface WithDiscountTaxBase {
  discountTaxBase?: DiscountTaxBaseValue;
}
