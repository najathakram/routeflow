import { isWholeCents } from "@routeflow/pricing";

/**
 * SA-1048 G-3: migration.service.ts `normalizedPrice` held a numeric cell to two decimals with
 * `Math.round(raw * 100) / 100 !== raw`; it now asks `isWholeCents(raw)`. The two must accept and refuse the
 * same numbers: every cent from 0.00 to 100.00, plus the half-cent and three-decimal cases.
 */
const oldRefuses = (raw: number) => Math.round(raw * 100) / 100 !== raw;

describe("SA-1048 G-3: isWholeCents agrees with the check normalizedPrice used", () => {
  it("accepts and refuses the same values for every cent from 0.00 to 100.00", () => {
    const differ: number[] = [];
    for (let cents = 0; cents <= 10000; cents++) {
      const n = cents / 100;
      if (oldRefuses(n) !== !isWholeCents(n)) differ.push(n);
    }
    expect(differ).toEqual([]);
  });

  it.each([1.005, 1.234, 2.135, 0.001])("refuses a sub-cent number the same way (%s)", (n) => {
    expect(oldRefuses(n)).toBe(true);
    expect(isWholeCents(n)).toBe(false);
  });

  it("refuses NaN and Infinity (the old check let Infinity through to a later isFinite refusal)", () => {
    expect(isWholeCents(Number.NaN)).toBe(false);
    expect(isWholeCents(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
