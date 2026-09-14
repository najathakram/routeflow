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
 * for a degenerate zero-or-negative subtotal (the guard this helper always
 * applies). That guard's 0 agrees with the three proportional `regularTax`
 * call sites (`orderTax * (lineSubtotal / orderSubtotal)`) only when the
 * order header's subtotal equals the sum of its lines — the normal case,
 * since no line item ever has a negative subtotal (validated at creation).
 * A header desynced from its lines (subtotal stored as 0 while lines sum to
 * something > 0 and `tax` is a stale non-zero from an older code path) is a
 * pre-existing data inconsistency this helper does not detect or resolve —
 * it will report a 0 rate for that row same as the genuine zero-subtotal case.
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
