import {
  DISCOUNT_PRE_TAX_FROM,
  LEGACY_DISCOUNT_BASE,
  computeInvoiceTotals,
  discountTaxBaseOf,
  type DiscountTaxBase,
  type InvoiceTotalsLine,
} from "@routeflow/pricing";
import type { DiscountTaxBaseValue } from "@routeflow/types";

/**
 * SA-1141 / W-989 (R7): the discount tax base a footer previews with.
 *   - a document that EXISTS reads the server's wire field (`discountTaxBase`); a response without it (an older server)
 *     is LEGACY, never a guess from the clock;
 *   - a NEW document (new invoice, the till, a new order, a new estimate) is created "now", so its base is the one the
 *     server will stamp: `discountTaxBaseOf({ createdAt: now }, DISCOUNT_PRE_TAX_FROM)`. The server stays authoritative; a
 *     footer one second off at the flip instant is corrected by the saved document.
 */
export function wireDiscountBase(field: DiscountTaxBaseValue | null | undefined): DiscountTaxBase {
  return field === "PRE_TAX" ? "PRE_TAX" : LEGACY_DISCOUNT_BASE;
}

export function newDocumentDiscountBase(now: Date = new Date()): DiscountTaxBase {
  return discountTaxBaseOf({ createdAt: now }, DISCOUNT_PRE_TAX_FROM);
}

/**
 * The invoice builders' footer: boxed-aware line totals, the signed "Adjustment" (negative = invoice discount, positive =
 * surcharge) and the tax, all from the one `computeInvoiceTotals`. `discountBase` is the document's (wire) or a new one's.
 */
export function invoiceFooterTotals(
  lines: readonly InvoiceTotalsLine[],
  o: { discount: number; shipping: number; taxRate?: number; discountBase: DiscountTaxBase },
) {
  return computeInvoiceTotals(lines, { ...o, discountBase: o.discountBase });
}
