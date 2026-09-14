/**
 * `SystemConfig` key "settings.taxRate" stores a PERCENT (0–100, string) — every
 * client (web, mobile) divides the stored value by 100 before using it as a
 * multiplier. `orders.service.getTaxRate()` was the one server reader that
 * treated the same stored value as an already-divided FRACTION, so a tenant
 * with `taxRate = "5"` (meaning 5%) would have been taxed at 500%. This helper
 * is now the ONLY parser of that setting: it centralizes the percent→fraction
 * conversion so every reader agrees on the unit.
 *
 * The 0–100 clamp exists because `PATCH /settings` historically stored
 * whatever string it was given with no validation — a direct API call (not the
 * web form, which enforces min(0)/max(100)) could and did persist an
 * out-of-range value like "150". Clamping here makes any such stored value
 * inert without having to backfill or rewrite tenant data.
 *
 * Takes the stored PERCENT string; returns a FRACTION ready to multiply.
 */
export function taxRateFractionFrom(stored: string | null): number {
  if (stored === null || stored === "") return 0;
  const pct = parseFloat(stored);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(Math.max(pct, 0), 100) / 100;
}

/**
 * B294: the effective REGULAR (non-category) tax rate to stamp on invoice
 * lines derived from an order or a converted estimate. Both rows store one
 * flat tax amount over their whole subtotal — `order.tax = subtotal * rate`,
 * `estimate.taxAmount = subtotal * rate` — rather than a per-line rate, so
 * `tax / subtotal` recovers that same rate exactly.
 *
 * Zero for an exempt customer (mirrors foldCategoryTax's contract), and zero
 * for a degenerate zero-or-negative subtotal: no line item ever has a
 * negative subtotal (validated at creation), so a row-level subtotal of 0
 * implies every one of its lines is also 0 — the proportional formulas used
 * at the order-splitting call sites (`orderTax * (lineSubtotal /
 * orderSubtotal)`) already land on 0 in that case for the same reason; this
 * guard just makes the 0 explicit instead of relying on a 0-numerator to
 * cancel out a defaulted denominator.
 *
 * Shared by invoices.service.ts (order-derived lines) and
 * estimates.service.ts (estimate→invoice conversion) — one implementation,
 * no copy.
 */
export function effectiveTaxRateFromTotals(
  tax: unknown,
  subtotal: unknown,
  isTaxExempt: boolean,
): number {
  if (isTaxExempt) return 0;
  const rowSubtotal = Number(subtotal) || 0;
  if (rowSubtotal <= 0) return 0;
  return Number(tax ?? 0) / rowSubtotal;
}
