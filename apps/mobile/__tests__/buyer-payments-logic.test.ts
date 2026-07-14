/**
 * Locks the buyer Payments screen's pure display helpers: month-bucket
 * labeling, payment-method formatting, the active-credit-rows filter (NOT a
 * wallet recompute), and per-row void/NSF flags.
 */
import {
  activeCreditRows,
  formatPaymentMethod,
  monthLabel,
  paymentRowFlags,
} from "../lib/buyer-payments-logic";
import type { BuyerStatementTransaction } from "../lib/api/buyer";

describe("monthLabel", () => {
  it("formats a YYYY-MM bucket as a UTC-safe long month + year", () => {
    expect(monthLabel("2026-07")).toBe("July 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2026-12")).toBe("December 2026");
  });

  it("returns malformed buckets as-is instead of Invalid Date", () => {
    expect(monthLabel("not-a-month")).toBe("not-a-month");
    expect(monthLabel("2026-13")).toBe("2026-13");
    expect(monthLabel("2026")).toBe("2026");
    expect(monthLabel("")).toBe("");
  });
});

describe("formatPaymentMethod", () => {
  it("title-cases underscored method codes", () => {
    expect(formatPaymentMethod("CREDIT_CARD")).toBe("Credit Card");
    expect(formatPaymentMethod("BANK_TRANSFER")).toBe("Bank Transfer");
  });

  it("title-cases a short code like ACH without over-capitalizing", () => {
    expect(formatPaymentMethod("ACH")).toBe("Ach");
  });

  it("falls back to Payment for a missing method", () => {
    expect(formatPaymentMethod(undefined)).toBe("Payment");
    expect(formatPaymentMethod(null)).toBe("Payment");
    expect(formatPaymentMethod("")).toBe("Payment");
  });
});

describe("activeCreditRows", () => {
  const tx = (over: Partial<BuyerStatementTransaction>): BuyerStatementTransaction => ({
    type: "CREDIT_NOTE",
    id: "1",
    description: "Credit",
    date: "2026-07-01",
    amount: 100,
    runningBalance: 100,
    status: "OPEN",
    ...over,
  });

  it("keeps only CREDIT_NOTE rows with a remaining balance above the epsilon", () => {
    const rows = [
      tx({ id: "a", runningBalance: 50 }),
      tx({ id: "b", type: "INVOICE", runningBalance: 50 }),
      tx({ id: "c", type: "ADVANCE_PAYMENT", runningBalance: 50 }),
      tx({ id: "d", runningBalance: 0 }),
      tx({ id: "e", runningBalance: 0.001 }),
    ];
    expect(activeCreditRows(rows).map((r) => r.id)).toEqual(["a"]);
  });

  it("returns an empty array for undefined/empty input (no crash)", () => {
    expect(activeCreditRows(undefined)).toEqual([]);
    expect(activeCreditRows([])).toEqual([]);
  });
});

describe("paymentRowFlags", () => {
  it("flags a plain VOID payment with no NSF note", () => {
    expect(paymentRowFlags({ status: "VOID" })).toEqual({ voided: true, showNsfFee: false });
  });

  it("shows the NSF fee note only when the check bounced and a fee amount is present", () => {
    expect(paymentRowFlags({ checkStatus: "BOUNCED", nsfFeeAmount: 25 })).toEqual({
      voided: false,
      showNsfFee: true,
    });
    expect(paymentRowFlags({ checkStatus: "BOUNCED", nsfFeeAmount: "25.00" })).toEqual({
      voided: false,
      showNsfFee: true,
    });
  });

  it("does not show the NSF note when bounced but no fee amount was recorded", () => {
    expect(paymentRowFlags({ checkStatus: "BOUNCED", nsfFeeAmount: null })).toEqual({
      voided: false,
      showNsfFee: false,
    });
    expect(paymentRowFlags({ checkStatus: "BOUNCED" })).toEqual({
      voided: false,
      showNsfFee: false,
    });
  });

  it("does not show the NSF note for a non-bounced check even with a fee amount present", () => {
    expect(paymentRowFlags({ checkStatus: "CLEARED", nsfFeeAmount: 25 })).toEqual({
      voided: false,
      showNsfFee: false,
    });
  });

  it("can combine voided + NSF-fee flags on the same row", () => {
    expect(paymentRowFlags({ status: "VOID", checkStatus: "BOUNCED", nsfFeeAmount: 25 })).toEqual({
      voided: true,
      showNsfFee: true,
    });
  });
});
