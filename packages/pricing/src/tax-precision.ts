/**
 * R5-1 (SA-814 §3, B296): ONE precision for every sales-tax rate. A line / template rate is a FRACTION stored as
 * Decimal(9,6); a 6-dp fraction is a percent to 4 dp (7.0625%), which covers every published US combined rate.
 * The tenant's default rate (`settings.taxRate`) is a PERCENT, so its cap is 4 decimals: the same precision seen
 * from the other side. api (PATCH /settings), web (settings form, invoice edit) and mobile (settings screen) all
 * read these, so no client re-derives the cut.
 */
export const TAX_RATE_FRACTION_DECIMALS = 6;
export const TAX_PERCENT_DECIMALS = TAX_RATE_FRACTION_DECIMALS - 2;
export const TAX_PERCENT_PRECISION_MESSAGE = `Tax rate can have at most ${TAX_PERCENT_DECIMALS} decimal places (for example 8.875)`;

/**
 * Do a stored line rate and a configured rate (both FRACTIONS) agree at the legacy 4-dp column precision? The one
 * comparison behind "a stored rate is a snapshot of the tenant's rate" (receipt wording, `storedTaxRatePercent`) and
 * the duplicate's "rounded rate" test (`retakeDuplicateTaxRates`), so neither re-derives the cut.
 */
export function sameRateAtLegacyPrecision(
  storedFraction: number,
  configuredFraction: number,
): boolean {
  const scale = 10 ** TAX_PERCENT_DECIMALS;
  // Snap the product to 6 places BEFORE rounding: 8.625 / 100 * 1e4 is 862.4999999999999 in float, but the legacy
  // column (Decimal(5,4)) rounds the true half up and holds 0.0863 (863).
  const snap = (x: number) => Math.round(Number((x * scale).toFixed(6)));
  return snap(storedFraction) === snap(configuredFraction);
}

/**
 * The refusal copy when a typed percent carries more than 4 decimals, else null. Silent about everything another
 * validator owns (not a number, out of 0..100, blank): it judges precision only. `stored` is the tenant's current
 * value: a CHANGED rate is held to 4 decimals, an unchanged one is not.
 */
export function taxPercentPrecisionError(percent: unknown, stored?: unknown): string | null {
  if (percent === null || percent === undefined || percent === "") return null;
  const n = Number(percent);
  if (!Number.isFinite(n)) return null;
  // Review Q5 (lead ruling): a rate equal to the tenant's STORED one is accepted whatever its decimals - saving the
  // phone number must not fail on an old 5-decimal rate. EXACT equality (same decimal), never a rounded comparison.
  if (stored !== null && stored !== undefined && stored !== "" && Number(stored) === n) return null;
  const scaled = n * 10 ** TAX_PERCENT_DECIMALS;
  return Math.abs(scaled - Math.round(scaled)) > 1e-6 ? TAX_PERCENT_PRECISION_MESSAGE : null;
}
