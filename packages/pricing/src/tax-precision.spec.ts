import {
  TAX_PERCENT_DECIMALS,
  TAX_RATE_FRACTION_DECIMALS,
  TAX_PERCENT_PRECISION_MESSAGE,
  taxPercentPrecisionError,
  sameRateAtLegacyPrecision,
} from "./tax-precision";

/** R5-1 (SA-814 §3 / B296): one precision for every sales-tax rate: 6 dp fraction = 4 dp percent. */
describe("tax rate precision", () => {
  it("a 6-dp fraction is a percent to 4 dp", () => {
    expect(TAX_RATE_FRACTION_DECIMALS).toBe(6);
    expect(TAX_PERCENT_DECIMALS).toBe(4);
  });

  it.each([
    ["8.875", 8.875],
    ["7.0625 (a published US combined rate)", 7.0625],
    ["a whole percent", 8],
    ["0", 0],
    ["100", 100],
    ["a numeric string", "8.8750"],
    ["a float-noisy 4-dp percent", 0.1 + 0.2 + 8.5749],
  ])("accepts %s", (_label, v) => {
    expect(taxPercentPrecisionError(v)).toBeNull();
  });

  it.each([
    ["5 decimals", 8.87501],
    ["a fraction typed to 6 dp", "0.088751"],
    ["8.12345", 8.12345],
  ])("refuses %s with the one message", (_label, v) => {
    expect(taxPercentPrecisionError(v)).toBe(TAX_PERCENT_PRECISION_MESSAGE);
  });

  it("sameRateAtLegacyPrecision: the 4-dp column cut of 8.875% (0.0888) agrees with 0.08875, 6.25% does not", () => {
    expect(sameRateAtLegacyPrecision(0.0888, 0.08875)).toBe(true);
    expect(sameRateAtLegacyPrecision(0.08875, 0.08875)).toBe(true);
    expect(sameRateAtLegacyPrecision(0.0625, 0.08875)).toBe(false);
  });

  it("is silent about values other validators own (not a number, out of range)", () => {
    expect(taxPercentPrecisionError("abc")).toBeNull();
    expect(taxPercentPrecisionError(150)).toBeNull();
    expect(taxPercentPrecisionError(undefined)).toBeNull();
  });
});
