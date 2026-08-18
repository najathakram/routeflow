import { taxRateFractionFrom } from "./tax-rate";

describe("taxRateFractionFrom", () => {
  it("converts a stored percent string to a fraction", () => {
    expect(taxRateFractionFrom("10")).toBe(0.1);
  });

  it("returns 0 for a stored zero percent", () => {
    expect(taxRateFractionFrom("0")).toBe(0);
  });

  it("returns 0 for an empty string", () => {
    expect(taxRateFractionFrom("")).toBe(0);
  });

  it("returns 0 for null", () => {
    expect(taxRateFractionFrom(null)).toBe(0);
  });

  it("clamps a stored value above 100 down to 100 (1.0 fraction)", () => {
    expect(taxRateFractionFrom("150")).toBe(1);
  });

  it("clamps a negative stored value up to 0", () => {
    expect(taxRateFractionFrom("-5")).toBe(0);
  });

  it("returns 0 for a non-numeric stored value", () => {
    expect(taxRateFractionFrom("abc")).toBe(0);
  });

  it("converts a fractional percent string to a fraction", () => {
    expect(taxRateFractionFrom("0.5")).toBe(0.005);
  });
});
