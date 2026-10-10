import {
  foldDayClose,
  expectedCashOf,
  type WindowFacts,
  type WindowPayment,
} from "./day-close-fold";

/**
 * The close's pure fold: what is TILL cash, what is not, and what a refund with no recorded tender does. Placeholders only (acme).
 */
const pay = (over: Partial<WindowPayment> & { amount: number }): WindowPayment => ({
  method: "CASH",
  status: "PAID",
  paymentGroupId: null,
  checkStatus: null,
  invoice: { orderId: "o-1" },
  ...over,
});
const facts = (over: Partial<WindowFacts> = {}): WindowFacts => ({
  sales: { _count: { _all: 0 }, _sum: { total: 0 } },
  payments: [],
  paidOnSales: { _sum: { amount: 0 } },
  returns: [],
  ...over,
});
const refund = (amount: number, refundTender: string | null) => ({
  refundMethod: "EXTERNAL_REFUND",
  refundTender,
  refundAmount: amount,
  creditSubtotal: null,
  creditTax: null,
  creditCategoryTax: null,
});

describe("foldDayClose: till cash", () => {
  it("0.10 + 0.10 + 0.10 of cash is 0.30, never 0.30000000000000004", () => {
    const f = foldDayClose(
      facts({ payments: [pay({ amount: 0.1 }), pay({ amount: 0.1 }), pay({ amount: 0.1 })] }),
    );
    expect(f.tillCash).toBe(0.3);
    expect(f.totals.moneyIn).toEqual({ cash: 0.3, card: 0, check: 0, other: 0, total: 0.3 });
    expect(expectedCashOf(0, f)).toBe(0.3);
  });

  it("expected = float + till cash - cash refunds, to the cent", () => {
    const f = foldDayClose(
      facts({
        payments: [pay({ amount: 10.1 }), pay({ amount: 5.2 })],
        returns: [refund(3.3, "CASH")],
      }),
    );
    expect(f.tillCash).toBe(15.3);
    expect(f.cashRefunds).toBe(3.3);
    expect(expectedCashOf(100.1, f)).toBe(112.1);
  });

  it("an office cash payment on a counter invoice (it carries a group id of its own) is NOT till cash: it is 'not taken at the till'", () => {
    const f = foldDayClose(
      facts({
        payments: [pay({ amount: 20 }), pay({ amount: 7.25, paymentGroupId: "office-group" })],
      }),
    );
    expect(f.tillCash).toBe(20);
    expect(f.totals.moneyIn.cash).toBe(20);
    expect(f.totals.notAtTill).toBe(7.25);
    expect(expectedCashOf(0, f)).toBe(20);
  });

  it("a deposited check and an ACH payment are not at the till either", () => {
    const f = foldDayClose(
      facts({
        payments: [
          pay({ amount: 40, method: "CHECK", checkStatus: "DEPOSITED" }),
          pay({ amount: 12.5, method: "ACH" }),
          pay({ amount: 9, method: "CHECK", checkStatus: null }),
        ],
      }),
    );
    expect(f.totals.moneyIn.check).toBe(9);
    expect(f.totals.notAtTill).toBe(52.5);
  });

  it("card and check tenders are money in but never cash; credit applications are store credit, not money in", () => {
    const f = foldDayClose(
      facts({
        payments: [
          pay({ amount: 11, method: "CREDIT_CARD" }),
          pay({ amount: 4, method: "CHECK" }),
          pay({ amount: 6, method: "CREDIT_NOTE" }),
          pay({ amount: 2, method: "ADVANCE" }),
        ],
      }),
    );
    expect(f.tillCash).toBe(0);
    expect(f.totals.moneyIn).toEqual({ cash: 0, card: 11, check: 4, other: 0, total: 15 });
    expect(f.totals.storeCreditUsed).toBe(8);
    expect(f.totals.notAtTill).toBe(0);
  });

  it("a payment that is not PAID never counts", () => {
    const f = foldDayClose(
      facts({
        payments: [pay({ amount: 50, status: "DRAFT" }), pay({ amount: 1, status: "VOID" })],
      }),
    );
    expect(f.tillCash).toBe(0);
    expect(f.totals.notAtTill).toBe(0);
  });
});

describe("foldDayClose: refunds by tender", () => {
  it("a refund with NO recorded tender is never cash: it is 'other', tenderKnown is false, the unknown count rises, and the drawer keeps the money", () => {
    const f = foldDayClose(
      facts({
        payments: [pay({ amount: 30 })],
        returns: [refund(12, null), refund(5, "CASH")],
      }),
    );
    expect(f.totals.refunds).toMatchObject({
      count: 2,
      cash: 5,
      other: 12,
      total: 17,
      tenderKnown: false,
      unknownTenderCount: 1,
    });
    expect(f.cashRefunds).toBe(5);
    expect(expectedCashOf(0, f)).toBe(25);
  });

  it("every refund with a tender: tenderKnown is true and the count is zero", () => {
    const f = foldDayClose(
      facts({ returns: [refund(4, "CREDIT_CARD"), refund(6, "CHECK"), refund(1, "CASH")] }),
    );
    expect(f.totals.refunds).toMatchObject({
      card: 4,
      check: 6,
      cash: 1,
      other: 0,
      tenderKnown: true,
      unknownTenderCount: 0,
    });
  });

  it("an unrecognised tender column (ZELLE) reads as unknown, not cash", () => {
    const f = foldDayClose(facts({ returns: [refund(8, "ZELLE")] }));
    expect(f.totals.refunds.tenderKnown).toBe(false);
    expect(f.cashRefunds).toBe(0);
  });

  it("a store-credit return is credit issued, not a refund", () => {
    const f = foldDayClose(
      facts({
        returns: [
          {
            refundMethod: "CREDIT_NOTE",
            refundTender: null,
            refundAmount: 9,
            creditSubtotal: 8,
            creditTax: 1,
            creditCategoryTax: 0,
          },
        ],
      }),
    );
    expect(f.totals.refunds.count).toBe(0);
    expect(f.totals.refunds.unknownTenderCount).toBe(0);
    expect(f.totals.storeCreditIssued).toEqual({ count: 1, amount: 9 });
  });
});

describe("foldDayClose: the summary", () => {
  it("sales, on account and net collected come from the Today's-sales fold", () => {
    const f = foldDayClose(
      facts({
        sales: { _count: { _all: 3 }, _sum: { total: 100 } },
        payments: [pay({ amount: 60 }), pay({ amount: 15, method: "CREDIT_CARD" })],
        paidOnSales: { _sum: { amount: 75 } },
        returns: [refund(10, "CASH")],
      }),
    );
    expect(f.totals).toMatchObject({
      salesCount: 3,
      salesTotal: 100,
      onAccount: 25,
      netCollected: 65,
    });
  });

  it("stores the summary only: no rows, no customer names", () => {
    const f = foldDayClose(facts({ payments: [pay({ amount: 5 })] }));
    expect(Object.keys(f.totals).sort()).toEqual(
      [
        "salesCount",
        "salesTotal",
        "moneyIn",
        "refunds",
        "storeCreditUsed",
        "storeCreditIssued",
        "onAccount",
        "netCollected",
        "notAtTill",
      ].sort(),
    );
    expect(JSON.stringify(f.totals)).not.toMatch(/customer|invoice|order/i);
  });
});
