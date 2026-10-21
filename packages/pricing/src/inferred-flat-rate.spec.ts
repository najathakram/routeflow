import { flatRateFromTotals, inferredFlatRate } from "./inferred-flat-rate";

/** B294 (SA-141): the shared inferred-flat-rate rule. */
describe("B294 — inferredFlatRate", () => {
  const line = (taxRate: number, categoryTaxAmount = 0) => ({ taxRate, categoryTaxAmount });

  it("REG-B294: a $100 invoice at 7.5% whose lines all carry 0 infers 0.075, verified", () => {
    expect(inferredFlatRate({ subtotal: 100, taxAmount: 7.5, lines: [line(0), line(0)] })).toEqual({
      rate: 0.075,
      regularTax: 7.5,
      verified: true,
    });
  });

  it("recovers a rate that reproduces the tax (8.07 on $97.77 → 0.082541 at 6 dp, verified)", () => {
    // R5-1: at 4 dp this read 0.0825; the 6-dp rate is the closest one that reproduces the stored tax.
    expect(inferredFlatRate({ subtotal: 97.77, taxAmount: 8.07, lines: [line(0)] })).toMatchObject({
      rate: 0.082541,
      verified: true,
    });
  });

  it("subtracts category (excise) tax: only the REGULAR tax implies the rate", () => {
    const r = inferredFlatRate({ subtotal: 100, taxAmount: 12.5, lines: [line(0, 5), line(0)] });
    expect(r).toMatchObject({ rate: 0.075, regularTax: 7.5, verified: true });
  });

  it("MIXED: one line at 7.5% and one at 0 is NOT inferred (the rated line is authoritative)", () => {
    expect(
      inferredFlatRate({ subtotal: 100, taxAmount: 3.75, lines: [line(0.075), line(0)] }),
    ).toBeNull();
  });

  it.each([
    ["no tax", { subtotal: 100, taxAmount: 0, lines: [line(0)] }],
    ["only category tax", { subtotal: 100, taxAmount: 5, lines: [line(0, 5)] }],
    ["a zero subtotal", { subtotal: 0, taxAmount: 7.5, lines: [line(0)] }],
    ["no lines", { subtotal: 100, taxAmount: 7.5, lines: [] }],
  ])("returns null for %s", (_label, invoice) => {
    expect(inferredFlatRate(invoice)).toBeNull();
  });

  it("flags a rate that cannot reproduce the tax to the cent as NOT verified", () => {
    // $7.33 on $100,000 is 0.0000733, which rounds to 0.000073 at 6dp → $7.30, not $7.33.
    const r = inferredFlatRate({ subtotal: 100_000, taxAmount: 7.33, lines: [line(0)] });
    expect(r).toMatchObject({ rate: 0.000073, regularTax: 7.33, verified: false });
  });

  // R5-1 (SA-814 §3, B296): InvoiceItem.taxRate is Decimal(9,6) since the widen, so the inference rounds to 6 dp.
  it("REG-B296: 8.875% on $1,000 ($88.75) infers 0.08875 and VERIFIES (4 dp gave 0.0888 -> $88.80, unverified)", () => {
    expect(inferredFlatRate({ subtotal: 1000, taxAmount: 88.75, lines: [line(0)] })).toEqual({
      rate: 0.08875,
      regularTax: 88.75,
      verified: true,
    });
  });

  it("recovers a 3-decimal rate on an awkward subtotal ($109.57 on $1,234.56 -> 0.088752, verified)", () => {
    expect(inferredFlatRate({ subtotal: 1234.56, taxAmount: 109.57, lines: [line(0)] })).toEqual({
      rate: 0.088752,
      regularTax: 109.57,
      verified: true,
    });
  });

  it("flatRateFromTotals guards a zero or negative subtotal", () => {
    expect(flatRateFromTotals(7.5, 100)).toBe(0.075);
    expect(flatRateFromTotals(7.5, 0)).toBe(0);
    expect(flatRateFromTotals(7.5, -1)).toBe(0);
  });
});
