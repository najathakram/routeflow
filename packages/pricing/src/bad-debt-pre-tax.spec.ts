import { badDebtPreTax } from "./bad-debt-pre-tax";

describe("badDebtPreTax (SA-1050 rule 2: the pre-tax share of a write-off)", () => {
  it("107.00 with 7.00 tax, 53.50 owed: 50.00 pre-tax", () => {
    expect(badDebtPreTax(53.5, 107, 7)).toBe(50);
  });

  it("no tax: the whole amount", () => {
    expect(badDebtPreTax(50, 50, 0)).toBe(50);
  });

  it("10.67 owed on 10.70 (tax 0.70): 9.97, rounded to cents per invoice", () => {
    expect(badDebtPreTax(10.67, 10.7, 0.7)).toBe(9.97);
    // three of them: 29.91 per row, where the old sum-then-round read 29.92
    expect(Math.round(badDebtPreTax(10.67, 10.7, 0.7) * 3 * 100)).toBe(2991);
  });

  it("a total of 0 (or less) is 0, never a divide by zero", () => {
    expect(badDebtPreTax(10, 0, 0)).toBe(0);
    expect(badDebtPreTax(10, -5, 0)).toBe(0);
  });

  it("a non-finite input is 0, not NaN", () => {
    expect(badDebtPreTax(NaN, 10, 1)).toBe(0);
    expect(badDebtPreTax(5, Infinity, 1)).toBe(0);
  });

  it("strings (Decimal read as text) and nulls coerce", () => {
    expect(badDebtPreTax("53.50", "107.00", "7.00")).toBe(50);
    expect(badDebtPreTax(null, 10, 1)).toBe(0);
  });
});
