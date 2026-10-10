/**
 * SA-764: the one tax rate a counter sale carries, as the percent a receipt prints ("Tax (8.25%)").
 * Read from the STORED invoice-line rates (a fraction, 0.0825): the single distinct non-zero rate x 100,
 * rounded to 3 dp. null when the lines carry several different rates (a mixed or regulated sale) or none.
 * Never re-derives a rate from amounts.
 */
export function saleTaxRatePercent(items: ReadonlyArray<{ taxRate: unknown }>): number | null {
  const rates = new Set<number>();
  for (const { taxRate } of items) {
    const rate = Number(taxRate ?? 0);
    if (rate > 0) rates.add(rate);
  }
  if (rates.size !== 1) return null;
  const [rate] = [...rates];
  return Math.round(rate * 100 * 1000) / 1000;
}
