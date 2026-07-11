/**
 * Locks the buyer Finances screen's plain-UI math: invoice-breakdown percentages
 * and monthly-spend bar normalization (no chart lib).
 */
import {
  invoiceBreakdownRows,
  maxMonthlySpend,
  monthlySpendFraction,
} from "../lib/buyer-finances-logic";

describe("invoiceBreakdownRows", () => {
  it("computes each status share of the total count", () => {
    const rows = invoiceBreakdownRows({ paid: 6, unpaid: 3, overdue: 1 });
    expect(rows.map((r) => [r.key, r.count, r.pct])).toEqual([
      ["paid", 6, 60],
      ["unpaid", 3, 30],
      ["overdue", 1, 10],
    ]);
  });
  it("returns 0% for every row when there are no invoices (no divide-by-zero)", () => {
    expect(invoiceBreakdownRows({ paid: 0, unpaid: 0, overdue: 0 }).every((r) => r.pct === 0)).toBe(
      true,
    );
  });
});

describe("monthlySpendFraction / maxMonthlySpend", () => {
  it("normalizes each month against the max", () => {
    const months = [{ spend: 100 }, { spend: 50 }, { spend: 0 }];
    const max = maxMonthlySpend(months);
    expect(max).toBe(100);
    expect(monthlySpendFraction(100, max)).toBe(1);
    expect(monthlySpendFraction(50, max)).toBe(0.5);
    expect(monthlySpendFraction(0, max)).toBe(0);
  });
  it("returns 0 when the max is 0 (all-empty series) — no NaN heights", () => {
    expect(maxMonthlySpend([{ spend: 0 }, { spend: 0 }])).toBe(0);
    expect(monthlySpendFraction(0, 0)).toBe(0);
  });
  it("clamps out-of-range inputs to [0,1]", () => {
    expect(monthlySpendFraction(150, 100)).toBe(1);
    expect(monthlySpendFraction(-10, 100)).toBe(0);
  });
});
