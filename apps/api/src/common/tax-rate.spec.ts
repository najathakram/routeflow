import { currentTaxRate, taxRateFractionFrom } from "./tax-rate";

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

// PR-1c: extracted from orders.service.ts's private getTaxRate() so
// InlineReturnsQuoteService's unreferenced-chunk pricing can share the exact same reader
// (deferred PR-1b item — see inline-returns-quote.service.ts's fallbackTaxRate).
describe("currentTaxRate", () => {
  it("reads settings.taxRate through SystemConfigService.get and converts percent→fraction", async () => {
    const systemConfig = { get: jest.fn().mockResolvedValue("8") } as any;
    await expect(currentTaxRate(systemConfig)).resolves.toBe(0.08);
    expect(systemConfig.get).toHaveBeenCalledWith("settings.taxRate");
  });

  it("returns 0 for an unconfigured tenant (no surprise charge)", async () => {
    const systemConfig = { get: jest.fn().mockResolvedValue(null) } as any;
    await expect(currentTaxRate(systemConfig)).resolves.toBe(0);
  });
});
