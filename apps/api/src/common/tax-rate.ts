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
