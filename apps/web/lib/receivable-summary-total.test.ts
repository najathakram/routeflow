/**
 * Owner ruling 2026-10-11: the Receivable Summary shows an overpaid invoice's balance as a NEGATIVE
 * row, but its footer total stays a receivables total (what is owed), so it must not net the surplus
 * against what other invoices owe. Every other money surface is clamped the same way (row 310).
 */
import * as fs from "fs";
import * as path from "path";
import {
  receivableSummaryBalanceTotal,
  receivableSummaryBreakdown,
} from "./receivable-summary-total";

describe("receivableSummaryBalanceTotal", () => {
  it("does not net a negative (overpaid) row against what is owed", () => {
    expect(receivableSummaryBalanceTotal([{ balance: -30 }, { balance: 50 }])).toBe(50);
  });

  it("sums owing rows in cents and ignores zero rows", () => {
    expect(
      receivableSummaryBalanceTotal([{ balance: 0.1 }, { balance: 0.2 }, { balance: 0 }]),
    ).toBe(0.3);
  });

  it("an all-overpaid report totals 0, never negative or -0", () => {
    const total = receivableSummaryBalanceTotal([{ balance: -10 }, { balance: -0.01 }]);
    expect(Object.is(total, 0)).toBe(true);
  });

  it("the report footer uses it (not a raw sum of the signed rows)", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "app", "(dashboard)", "finance", "reports", "page.tsx"),
      "utf8",
    );
    expect(src).toContain("receivableSummaryBalanceTotal(rows)");
  });
});

// UX guide B7: the footer says what its figure is made of. The bottom line IS the existing figure.
describe("receivableSummaryBreakdown (UX guide B7)", () => {
  it("splits open invoices (clamped) from unused credit; the total is today's figure", () => {
    const rows = [
      { type: "INVOICE", balance: 100 },
      { type: "INVOICE", balance: -30 },
      { type: "CREDIT_NOTE", balance: 12.5 },
      { type: "PAYMENT", balance: 0 },
    ];
    expect(receivableSummaryBreakdown(rows)).toEqual({
      openInvoices: 100,
      unusedCredit: 12.5,
      total: 112.5,
    });
    expect(receivableSummaryBreakdown(rows).total).toBe(receivableSummaryBalanceTotal(rows));
  });
});
