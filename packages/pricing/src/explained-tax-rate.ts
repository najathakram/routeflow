import { inferredFlatRate } from "./inferred-flat-rate";
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
  if (ratePercent == null || !(ratePercent > 0) || tax === 0) return null;
  return tax === roundMoney((base * ratePercent) / 100) ? ratePercent : null;
}

/** The Tax row's label, everywhere: "Tax (8.25%)" when one rate explains the tax, else plain "Tax". */
export const taxRowLabel = (ratePercent: number | null | undefined): string =>
  ratePercent == null ? "Tax" : `Tax (${Number(ratePercent.toFixed(3))}%)`;

/**
 * The single stored rate of a sale's live invoice lines, in percent, or null when there is none or it is mixed. Reads the
 * stored `InvoiceItem.taxRate` (a fraction: 0.0825); a legacy invoice whose lines all store 0 falls back to the flat rate its
 * header tax implies (`inferredFlatRate`, only when verified). The result is a CANDIDATE: pass it through
 * `explainedTaxRatePercent` before naming it.
 */
export function storedTaxRatePercent(
  invoices: ReadonlyArray<{
    subtotal: unknown;
    taxAmount: unknown;
    lines: ReadonlyArray<{ taxRate?: unknown; categoryTaxAmount?: unknown }>;
  }>,
): number | null {
  const rates = new Set<number>();
  for (const inv of invoices)
    for (const l of inv.lines) {
      const r = Number(l.taxRate ?? 0);
      if (r > 0) rates.add(r);
    }
  if (rates.size === 1) return Number(([...rates][0] * 100).toFixed(4));
  if (rates.size > 1) return null;
  // every stored line rate is 0: a legacy flat-rate invoice, recoverable only for a single invoice
  if (invoices.length !== 1) return null;
  const guess = inferredFlatRate(invoices[0]);
  return guess && guess.verified ? Number((guess.rate * 100).toFixed(4)) : null;
}
