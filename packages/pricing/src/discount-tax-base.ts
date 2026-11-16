import { MoneyInvariantError } from "./money-invariants";

/**
 * SA-1141 / W-989: where an invoice-level discount sits relative to sales tax.
 *
 *   PRE_TAX         the discount lowers the tax base, spread pro-rata over ALL goods lines by subtotal
 *                   (taxable or not; the split `refundable-line-share.ts` already uses).
 *   LEGACY_POST_TAX master's formula: the discount never enters the tax base (comes off after tax).
 *
 * One union, REQUIRED by every totals / rate-inference helper, so the compiler finds each caller and an
 * omitted value throws at runtime (`assertDiscountTaxBase`), never defaults.
 */
export const DISCOUNT_TAX_BASE_VALUES = ["PRE_TAX", "LEGACY_POST_TAX"] as const;
export type DiscountTaxBase = (typeof DISCOUNT_TAX_BASE_VALUES)[number];

/**
 * What every pre-W-989 caller passes: master's formula, stated explicitly. PR-2 (SA-1141) replaces each use
 * with the document's own mode (`discountTaxBaseOf`); until then a grep for this name lists every call
 * site still to thread, and none changes behaviour.
 */
export const LEGACY_DISCOUNT_BASE: DiscountTaxBase = "LEGACY_POST_TAX";

/**
 * The cutover instant: a document whose own `createdAt` is at or after it uses PRE_TAX. `null` (dark) means
 * every document keeps master's formula. Flipped only in its own diff after the owner's yes (SA-1141 R10).
 */
export const DISCOUNT_PRE_TAX_FROM: Date | null = null;

/**
 * The mode of ONE document, a pure function of its immutable `createdAt` (so a document keeps its formula
 * for life: no re-total, PATCH, price adjustment or recompute ever re-taxes it). Production passes
 * `DISCOUNT_PRE_TAX_FROM`; tests pass an instant. A derived document passes its SOURCE's `createdAt` (R4).
 */
export function discountTaxBaseOf(doc: { createdAt: Date }, from: Date | null): DiscountTaxBase {
  return from != null && doc.createdAt.getTime() >= from.getTime() ? "PRE_TAX" : "LEGACY_POST_TAX";
}

/** Runtime half of "required": a JS caller that omits or mistypes the mode gets an error, not a default. */
export function assertDiscountTaxBase(mode: unknown): asserts mode is DiscountTaxBase {
  if (!(DISCOUNT_TAX_BASE_VALUES as readonly unknown[]).includes(mode)) {
    throw new MoneyInvariantError(
      "Invoice totals: discountBase is required (PRE_TAX or LEGACY_POST_TAX).",
    );
  }
}

/**
 * The amount a stored sales tax was levied ON, for rate inference (tax / base). LEGACY: the subtotal
 * (byte-identical to master). PRE_TAX: `subtotal - discount` (never below 0). A caller infers a rate only
 * when the result is above 0.
 */
export function taxRateBaseOf(
  subtotal: number,
  discount: number,
  discountBase: DiscountTaxBase,
): number {
  assertDiscountTaxBase(discountBase);
  if (discountBase === "LEGACY_POST_TAX") return subtotal;
  return Math.max(subtotal - (Number.isFinite(discount) ? discount : 0), 0);
}
