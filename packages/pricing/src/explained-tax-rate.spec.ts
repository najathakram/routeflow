import { explainedTaxRatePercent, storedTaxRatePercent, taxRowLabel } from "./explained-tax-rate";

describe("explainedTaxRatePercent (the one rule for naming a receipt's tax rate)", () => {
  it("compares the tax to the cent (an unrounded 2.1862 still reads as 2.19)", () => {
    expect(explainedTaxRatePercent({ base: 26.5, tax: 2.1862, ratePercent: 8.25 })).toBe(8.25);
  });
  it("names the rate only when it reproduces the tax to the cent over the net subtotal", () => {
    expect(explainedTaxRatePercent({ base: 26.5, tax: 2.19, ratePercent: 8.25 })).toBe(8.25);
    expect(explainedTaxRatePercent({ base: 26.5, tax: 2.2, ratePercent: 8.25 })).toBeNull();
    expect(explainedTaxRatePercent({ base: 26.5, tax: 3.19, ratePercent: 8.25 })).toBeNull();
  });
  it("never names a rate for no tax, an absent rate or a zero rate", () => {
    expect(explainedTaxRatePercent({ base: 10, tax: 0, ratePercent: 8.25 })).toBeNull();
    expect(explainedTaxRatePercent({ base: 10, tax: 0.5, ratePercent: null })).toBeNull();
    expect(explainedTaxRatePercent({ base: 10, tax: 0.5, ratePercent: undefined })).toBeNull();
    expect(explainedTaxRatePercent({ base: 10, tax: 0.5, ratePercent: 0 })).toBeNull();
  });
});

describe("taxRowLabel", () => {
  it("is Tax (rate%) when a rate is named, else plain Tax", () => {
    expect(taxRowLabel(8.25)).toBe("Tax (8.25%)");
    expect(taxRowLabel(7)).toBe("Tax (7%)");
    expect(taxRowLabel(null)).toBe("Tax");
    expect(taxRowLabel(undefined)).toBe("Tax");
  });
});

describe("storedTaxRatePercent (a STORED line rate, corroborated by the tenant's configured rate; never inferred)", () => {
  const inv = (taxRates: number[]) => ({
    lines: taxRates.map((taxRate) => ({ taxRate })),
  });
  it("one stored rate across the live lines that equals the configured rate is that rate in percent", () => {
    expect(storedTaxRatePercent([inv([0.0825, 0.0825])], 8.25)).toBe(8.25);
    expect(storedTaxRatePercent([inv([0.0825]), inv([0.0825])], 8.25)).toBe(8.25);
  });

  it("RULING: a rate back-calculated from tax / subtotal is never named (stored 8.27% against a configured 8.25% -> none)", () => {
    // order-derived invoice lines carry tax / subtotal at 4 dp: 1.86 / 22.50 = 0.0827
    expect(storedTaxRatePercent([inv([0.0827, 0.0827])], 8.25)).toBeNull();
    expect(storedTaxRatePercent([inv([0.084])], 8.25)).toBeNull();
  });

  it("with no configured rate to corroborate it (unset, zero, unknown), nothing is named", () => {
    expect(storedTaxRatePercent([inv([0.0825])], null)).toBeNull();
    expect(storedTaxRatePercent([inv([0.0825])], undefined)).toBeNull();
    expect(storedTaxRatePercent([inv([0.0825])], 0)).toBeNull();
  });

  it("a mixed rate is none", () => {
    expect(storedTaxRatePercent([inv([0.0825, 0.07])], 8.25)).toBeNull();
    expect(storedTaxRatePercent([inv([0.0825]), inv([0.06])], 8.25)).toBeNull();
  });

  it("zero-rate lines are ignored when another line carries the rate", () => {
    expect(storedTaxRatePercent([inv([0.0825, 0])], 8.25)).toBe(8.25);
  });

  it("a legacy invoice whose lines all store 0 names nothing: its rate is never inferred from the header tax", () => {
    expect(storedTaxRatePercent([inv([0, 0])], 8.25)).toBeNull();
    expect(storedTaxRatePercent([inv([0, 0]), inv([0, 0])], 8.25)).toBeNull();
  });

  it("no lines is none", () => {
    expect(storedTaxRatePercent([], 8.25)).toBeNull();
    expect(storedTaxRatePercent([inv([])], 8.25)).toBeNull();
  });

  it("compares at the stored precision (a configured 8.250 equals a stored 0.0825)", () => {
    expect(storedTaxRatePercent([inv([0.0825])], 8.25)).toBe(8.25);
    expect(storedTaxRatePercent([inv([0.0888])], 8.88)).toBe(8.88);
  });

  it("PRINTS the configured rate, not the stored one: a configured 8.875% against a stored 0.0888 is 'Tax (8.875%)', never 8.88%", () => {
    // the column is Decimal(5, 4): 8.875% is stored rounded to 0.0888, and it equals the configured rate at that precision
    expect(storedTaxRatePercent([inv([0.0888])], 8.875)).toBe(8.875);
    expect(taxRowLabel(storedTaxRatePercent([inv([0.0888])], 8.875))).toBe("Tax (8.875%)");
    expect(storedTaxRatePercent([inv([0.0825])], 8.25)).toBe(8.25);
    // a different configured rate at that precision still names nothing
    expect(storedTaxRatePercent([inv([0.0888])], 8.9)).toBeNull();
  });
});
