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

describe("storedTaxRatePercent (from the stored InvoiceItem.taxRate)", () => {
  const inv = (taxRates: number[], over: Record<string, unknown> = {}) => ({
    subtotal: "100.00",
    taxAmount: "8.25",
    lines: taxRates.map((taxRate) => ({ taxRate, categoryTaxAmount: 0 })),
    ...over,
  });
  it("one stored rate across the live lines is that rate in percent", () => {
    expect(storedTaxRatePercent([inv([0.0825, 0.0825])])).toBe(8.25);
    expect(storedTaxRatePercent([inv([0.0825]), inv([0.0825])])).toBe(8.25);
  });
  it("a mixed rate is none", () => {
    expect(storedTaxRatePercent([inv([0.0825, 0.07])])).toBeNull();
    expect(storedTaxRatePercent([inv([0.0825]), inv([0.06])])).toBeNull();
  });
  it("zero-rate lines are ignored when another line carries the rate", () => {
    expect(storedTaxRatePercent([inv([0.0825, 0])])).toBe(8.25);
  });
  it("a 4-dp stored rate keeps its precision (0.0888 -> 8.88)", () => {
    expect(storedTaxRatePercent([inv([0.0888])])).toBe(8.88);
  });
  it("a legacy invoice whose lines all store 0 uses the flat rate its header tax implies (single invoice only)", () => {
    expect(storedTaxRatePercent([inv([0, 0])])).toBe(8.25);
    expect(storedTaxRatePercent([inv([0, 0]), inv([0, 0])])).toBeNull();
  });
  it("no lines, or no tax at all, is none", () => {
    expect(storedTaxRatePercent([])).toBeNull();
    expect(storedTaxRatePercent([inv([0], { taxAmount: "0.00" })])).toBeNull();
  });
});
