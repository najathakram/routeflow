import { roundMoney } from "./pricing";
import { TAX_RATE_FRACTION_DECIMALS } from "./tax-precision";

/**
 * B294 (SA-141): the ONE rule for recovering a legacy invoice's flat sales-tax rate, shared by
 * the backfill script, invoices.service's applyPriceAdjustment and the mobile invoice edit.
 *
 * Order-derived and estimate-converted invoices used to store `taxRate: 0` on every line, while
 * the header carried the real tax (`order.tax = subtotal * rate`, one flat rate over the whole
 * subtotal). Any later recompute (`Σ line.subtotal * line.taxRate`) then silently dropped the
 * sales tax to $0. #725 fixed new invoices; lines stored before it still carry 0.
 */

/** `tax / subtotal`, the flat rate a header-level tax implies; 0 for a zero or negative subtotal. */
export function flatRateFromTotals(tax: unknown, subtotal: unknown): number {
  const s = Number(subtotal) || 0;
  if (s <= 0) return 0;
  return Number(tax ?? 0) / s;
}

export interface InferredFlatRate {
  /** The flat rate, at InvoiceItem.taxRate's own precision (Decimal(9, 6) since the B296 widen). */
  rate: number;
  /** The header's REGULAR tax: taxAmount minus the lines' category (excise) tax. */
  regularTax: number;
  /** roundMoney(subtotal * rate) === regularTax: the rate reproduces the tax exactly. */
  verified: boolean;
}

/**
 * The flat rate to infer for an invoice, or null when there is nothing to infer. It applies only
 * when ALL of these hold:
 *   - every line's taxRate is 0 (a single rated line means the lines are already authoritative);
 *   - the regular tax (taxAmount − Σ categoryTaxAmount) is above 0;
 *   - the subtotal is above 0.
 * `verified` is false when the rounded rate does not reproduce the stored tax to the cent. Callers
 * must not stamp an unverified rate (the backfill sends it to REVIEW).
 */
export function inferredFlatRate(invoice: {
  subtotal: unknown;
  taxAmount: unknown;
  lines: ReadonlyArray<{ taxRate?: unknown; categoryTaxAmount?: unknown }>;
}): InferredFlatRate | null {
  if (invoice.lines.length === 0) return null;
  if (invoice.lines.some((l) => Number(l.taxRate ?? 0) !== 0)) return null;
  const categoryTax = invoice.lines.reduce((s, l) => s + Number(l.categoryTaxAmount ?? 0), 0);
  const regularTax = roundMoney(Number(invoice.taxAmount ?? 0) - categoryTax);
  const subtotal = Number(invoice.subtotal) || 0;
  if (!(regularTax > 0) || !(subtotal > 0)) return null;
  const scale = 10 ** TAX_RATE_FRACTION_DECIMALS; // 6 dp: a percent to 4 dp (8.875% = 0.08875)
  const rate = Math.round(flatRateFromTotals(regularTax, subtotal) * scale) / scale;
  return { rate, regularTax, verified: roundMoney(subtotal * rate) === regularTax };
}
