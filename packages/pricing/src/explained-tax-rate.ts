import { roundMoney } from "./pricing";

/**
 * SA-762r / SA-751r: the ONE rule for when a receipt may NAME a tax rate. Counter receipt, reprint and the emailed receipt
 * all decide it here, so the three can never print a different Tax row for the same sale.
 *
 * `ratePercent` (8.25 = 8.25%) is named only when it reproduces `tax` to the cent over `base` (the receipt's net line
 * subtotal): a re-price, a credit or a regulated tax must never read as "Tax (8.25%)". Anything else is `null`, and the row
 * prints as plain "Tax" (`taxRowLabel(null)`).
 */
export function explainedTaxRatePercent(input: {
  base: number;
  tax: number;
  ratePercent: number | null | undefined;
}): number | null {
  const { base, tax, ratePercent } = input;
  const cents = roundMoney(tax);
  if (ratePercent == null || !(ratePercent > 0) || cents === 0) return null;
  return cents === roundMoney((base * ratePercent) / 100) ? ratePercent : null;
}

/** The Tax row's label, everywhere: "Tax (8.25%)" when one rate explains the tax, else plain "Tax". */
export const taxRowLabel = (ratePercent: number | null | undefined): string =>
  ratePercent == null ? "Tax" : `Tax (${Number(ratePercent.toFixed(3))}%)`;

/**
 * The tax rate a receipt may NAME for a sale, in percent, or null (the row then prints plain "Tax").
 *
 * RULING: a receipt never prints a back-calculated rate. An order-derived invoice stamps its lines with `tax / subtotal` at 4
 * dp (B294: the order stores no rate, only its tax), so a stored line rate is a SNAPSHOT of the tenant's rate only when it
 * equals the tenant's configured rate; a derived 0.0827 on a sale taxed at 8.25% must never read "Tax (8.27%)". So this
 * returns the single stored, non-zero line rate (a fraction: 0.0825) in percent ONLY when it equals `configuredPercent`
 * (`settings.taxRate`) at the stored precision. It never infers a rate from a header tax (the legacy all-zero-lines case is
 * plain "Tax"), and with no configured rate there is nothing to corroborate it. A CANDIDATE: pass it through
 * `explainedTaxRatePercent` before naming it.
 */
export function storedTaxRatePercent(
  invoices: ReadonlyArray<{ lines: ReadonlyArray<{ taxRate?: unknown }> }>,
  configuredPercent: number | null | undefined,
): number | null {
  const rates = new Set<number>();
  for (const inv of invoices)
    for (const l of inv.lines) {
      const r = Number(l.taxRate ?? 0);
      if (r > 0) rates.add(r);
    }
  if (rates.size !== 1) return null;
  if (configuredPercent == null || !(configuredPercent > 0)) return null;
  const stored = [...rates][0];
  // the column is Decimal(5, 4): compare at that precision, in basis points of the fraction
  if (Math.round(stored * 10_000) !== Math.round((configuredPercent / 100) * 10_000)) return null;
  // print the CONFIGURED rate: the stored column is Decimal(5, 4), so 8.875% is stored as 0.0888 and must not read 8.88%
  return configuredPercent;
}
