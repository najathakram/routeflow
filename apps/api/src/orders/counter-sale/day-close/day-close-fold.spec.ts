import { legGroupId } from "../counter-tender-row";
import { pickupTenderGroupId } from "../pickup-tender-group";
import { dayCloseWindowIsEmpty } from "@routeflow/pricing";
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
  invoice: { orderId: "o-1", order: { counterSale: true } }, // a counter sale unless a test says otherwise
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
        "handOver",
      ].sort(),
    );
    expect(JSON.stringify(f.totals)).not.toMatch(/customer|invoice|order/i);
  });
});

/** SA-750r3 r-note (Train 4 meets day close): a POS-mode pickup hand-over's cash is till cash; a driver / office row is not. */
describe("foldDayClose: a POS-mode pickup hand-over (a NON-counter order)", () => {
  const PICKUP_ORDER = "o-pickup";
  const nonCounter = (orderId: string) => ({ orderId, order: { counterSale: false } });
  const handOver = (amount: number, over: Partial<Omit<WindowPayment, "amount">> = {}) =>
    pay({
      amount,
      paymentGroupId: pickupTenderGroupId(PICKUP_ORDER),
      invoice: nonCounter(PICKUP_ORDER),
      ...over,
    });

  it("(1) its own-group cash row is in tillCash, moneyIn.cash and the expected cash", () => {
    const f = foldDayClose(facts({ payments: [pay({ amount: 30 }), handOver(20)] }));
    expect(f.tillCash).toBe(50);
    expect(f.totals.moneyIn).toEqual({ cash: 50, card: 0, check: 0, other: 0, total: 50 });
    expect(f.totals.notAtTill).toBe(0);
    expect(expectedCashOf(100, f)).toBe(150);
  });

  it("a hand-over card tender is money in by method, never cash", () => {
    const f = foldDayClose(facts({ payments: [handOver(15, { method: "CREDIT_CARD" })] }));
    expect(f.tillCash).toBe(0);
    expect(f.totals.moneyIn).toEqual({ cash: 0, card: 15, check: 0, other: 0, total: 15 });
  });

  it("(2) a driver / route cash row on a non-counter order (random group) is NOT till cash: not taken at the till", () => {
    const f = foldDayClose(
      facts({
        payments: [
          pay({
            amount: 40,
            paymentGroupId: "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11",
            invoice: nonCounter("o-delivery"),
          }),
        ],
      }),
    );
    expect(f.tillCash).toBe(0);
    expect(f.totals.moneyIn.cash).toBe(0);
    expect(f.totals.notAtTill).toBe(40);
  });

  it("(3) a non-counter order's UNGROUPED cash row (an office payment) is NOT till cash: not taken at the till", () => {
    const f = foldDayClose(
      facts({ payments: [pay({ amount: 12.5, invoice: nonCounter(PICKUP_ORDER) })] }),
    );
    expect(f.tillCash).toBe(0);
    expect(f.totals.notAtTill).toBe(12.5);
  });

  it("another order's pickup group id on this order is not its tender", () => {
    const f = foldDayClose(
      facts({
        payments: [
          pay({
            amount: 9,
            paymentGroupId: pickupTenderGroupId("o-other"),
            invoice: nonCounter(PICKUP_ORDER),
          }),
        ],
      }),
    );
    expect(f.tillCash).toBe(0);
    expect(f.totals.notAtTill).toBe(9);
  });

  it("(5) a counter order's ungrouped cash counts, and so does its OWN pickup-group hand-over cash", () => {
    const f = foldDayClose(
      facts({
        payments: [
          pay({ amount: 30 }),
          pay({ amount: 5, paymentGroupId: pickupTenderGroupId("o-1") }),
        ],
      }),
    );
    expect(f.tillCash).toBe(35);
    expect(f.totals.moneyIn).toEqual({ cash: 35, card: 0, check: 0, other: 0, total: 35 });
    expect(f.totals.notAtTill).toBe(0);
  });

  it("a counter order's row with ANOTHER order's pickup id is not till cash", () => {
    const f = foldDayClose(
      facts({
        payments: [
          pay({
            amount: 5,
            paymentGroupId: pickupTenderGroupId("o-other"),
            invoice: { orderId: "o-1", order: { counterSale: true } },
          }),
        ],
      }),
    );
    expect(f.tillCash).toBe(0);
    expect(f.totals.notAtTill).toBe(5);
  });

  it("a payment row with no order kind reads as non-counter: an ungrouped row never silently counts", () => {
    const f = foldDayClose(facts({ payments: [pay({ amount: 8, invoice: { orderId: "o-1" } })] }));
    expect(f.tillCash).toBe(0);
    expect(f.totals.notAtTill).toBe(8);
  });
});

/** SA ruling: `totals.handOver` is an informational breakdown of the till money that came from POS pickup hand-overs. */
describe("foldDayClose: totals.handOver", () => {
  const PICKUP_ORDER = "o-pickup";
  const nonCounter = (orderId: string) => ({ orderId, order: { counterSale: false } });
  const handOver = (amount: number, over: Partial<Omit<WindowPayment, "amount">> = {}) =>
    pay({
      amount,
      paymentGroupId: pickupTenderGroupId(PICKUP_ORDER),
      invoice: nonCounter(PICKUP_ORDER),
      ...over,
    });

  it("is zero on a window with only counter sales", () => {
    const f = foldDayClose(facts({ payments: [pay({ amount: 30 })] }));
    expect(f.totals.handOver).toEqual({ count: 0, cash: 0 });
  });

  it("counts every hand-over row; cash is the CASH ones only (a card hand-over counts, adds no cash)", () => {
    const f = foldDayClose(
      facts({
        payments: [
          handOver(20.1),
          handOver(10.2),
          handOver(15, { method: "CREDIT_CARD" }),
          handOver(5, { method: "CHECK", checkStatus: "RECORDED" }),
        ],
      }),
    );
    expect(f.totals.handOver).toEqual({ count: 4, cash: 30.3 });
  });

  it("ungrouped non-counter cash is NOT a hand-over (it is not a tender at all)", () => {
    const f = foldDayClose(
      facts({ payments: [pay({ amount: 12.5, invoice: nonCounter(PICKUP_ORDER) })] }),
    );
    expect(f.totals.handOver).toEqual({ count: 0, cash: 0 });
    expect(f.totals.notAtTill).toBe(12.5);
  });

  it("a counter sale's own cash is not a hand-over; a driver's random-group row is not either", () => {
    const f = foldDayClose(
      facts({
        payments: [
          pay({ amount: 30 }),
          pay({
            amount: 40,
            paymentGroupId: "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11",
            invoice: nonCounter("o-delivery"),
          }),
        ],
      }),
    );
    expect(f.totals.handOver).toEqual({ count: 0, cash: 0 });
  });

  it("a COUNTER order's own pickup-group cash is ordinary till cash: in tillCash and moneyIn.cash, NOT in handOver", () => {
    const counterHandOver = (amount: number, over: Partial<Omit<WindowPayment, "amount">> = {}) =>
      pay({
        amount,
        paymentGroupId: pickupTenderGroupId("o-counter"),
        invoice: { orderId: "o-counter", order: { counterSale: true } },
        ...over,
      });
    const f = foldDayClose(
      facts({
        payments: [
          pay({ amount: 30 }),
          counterHandOver(20),
          counterHandOver(8, { method: "CREDIT_CARD" }),
        ],
      }),
    );
    expect(f.tillCash).toBe(50);
    expect(f.totals.moneyIn).toEqual({ cash: 50, card: 8, check: 0, other: 0, total: 58 });
    expect(f.totals.notAtTill).toBe(0);
    expect(f.totals.handOver).toEqual({ count: 0, cash: 0 });
    // a non-counter POS pickup row beside it still counts as a hand-over, and only that one
    const both = foldDayClose(facts({ payments: [counterHandOver(20), handOver(15)] }));
    expect(both.tillCash).toBe(35);
    expect(both.totals.handOver).toEqual({ count: 1, cash: 15 });
  });

  it("a non-PAID hand-over row is ignored", () => {
    const f = foldDayClose(facts({ payments: [handOver(20, { status: "PENDING" })] }));
    expect(f.totals.handOver).toEqual({ count: 0, cash: 0 });
  });

  it("a deposited hand-over check is not a tender, so not a hand-over", () => {
    const f = foldDayClose(
      facts({ payments: [handOver(20, { method: "CHECK", checkStatus: "DEPOSITED" })] }),
    );
    expect(f.totals.handOver).toEqual({ count: 0, cash: 0 });
  });

  it("hand-over rows stay in moneyIn and tillCash exactly once (not added or subtracted again)", () => {
    const f = foldDayClose(
      facts({
        payments: [pay({ amount: 30 }), handOver(20), handOver(15, { method: "CREDIT_CARD" })],
      }),
    );
    expect(f.tillCash).toBe(50);
    expect(f.totals.moneyIn).toEqual({ cash: 50, card: 15, check: 0, other: 0, total: 65 });
    expect(f.totals.netCollected).toBe(65);
    expect(f.totals.handOver).toEqual({ count: 2, cash: 20 });
    expect(expectedCashOf(10, f)).toBe(60);
  });

  it("a window with only a hand-over is not empty (the close is not refused as 'nothing new')", () => {
    const f = foldDayClose(facts({ payments: [handOver(20)] }));
    expect(dayCloseWindowIsEmpty(f.totals)).toBe(false);
    const zero = foldDayClose(facts({ payments: [handOver(0)] }));
    expect(zero.totals.handOver).toEqual({ count: 1, cash: 0 });
    expect(dayCloseWindowIsEmpty(zero.totals)).toBe(false);
  });
});

/**
 * SA-749r2 meets SA-750r3: the ONE tender predicate is judged against the SALE's rows as a set. A split sale's legs carry
 * the order's own leg group ids; an ungrouped row beside them is an office payment (the facts read the order's other
 * grouped payments nested on the order), never till money.
 */
describe("foldDayClose: a split counter sale (the sale as a set)", () => {
  const ORDER = "ord-split";
  const leg = (i: number, amount: number, over: Partial<Omit<WindowPayment, "amount">> = {}) =>
    pay({
      amount,
      paymentGroupId: legGroupId(ORDER, i),
      invoice: { orderId: ORDER, order: { counterSale: true } },
      ...over,
    });
  const office = (amount: number, over: Partial<Omit<WindowPayment, "amount">> = {}) =>
    pay({
      amount,
      paymentGroupId: null,
      invoice: {
        orderId: ORDER,
        order: {
          counterSale: true,
          // the order's other live payments with a group id: the card leg and the cash leg
          invoices: [
            {
              payments: [
                { paymentGroupId: legGroupId(ORDER, 0), status: "PAID" },
                { paymentGroupId: legGroupId(ORDER, 1), status: "PAID" },
              ],
            },
          ],
        },
      },
      ...over,
    });

  it("a card leg and a cash leg are till money (cash counts the APPLIED amount of the row)", () => {
    const f = foldDayClose(
      facts({ payments: [leg(0, 30, { method: "CREDIT_CARD" }), leg(1, 20)] }),
    );
    expect(f.tillCash).toBe(20);
    expect(f.totals.moneyIn).toEqual({ cash: 20, card: 30, check: 0, other: 0, total: 50 });
    expect(f.totals.notAtTill).toBe(0);
  });

  it("an ungrouped office cash payment on that sale is 'not at the till', never expected cash", () => {
    const f = foldDayClose(facts({ payments: [leg(1, 20), office(7.5)] }));
    expect(f.tillCash).toBe(20);
    expect(f.totals.notAtTill).toBe(7.5);
  });

  it("the same ungrouped row on a LEGACY sale (no leg-grouped payment on the order) is till cash", () => {
    const legacy = pay({
      amount: 7.5,
      paymentGroupId: null,
      invoice: { orderId: ORDER, order: { counterSale: true, invoices: [{ payments: [] }] } },
    });
    const f = foldDayClose(facts({ payments: [legacy] }));
    expect(f.tillCash).toBe(7.5);
    expect(f.totals.notAtTill).toBe(0);
  });

  it("a leg row of ANOTHER order is not this sale's tender", () => {
    const stray = pay({
      amount: 9,
      paymentGroupId: legGroupId("ord-other", 0),
      invoice: { orderId: ORDER, order: { counterSale: true } },
    });
    const f = foldDayClose(facts({ payments: [stray] }));
    expect(f.tillCash).toBe(0);
    expect(f.totals.notAtTill).toBe(9);
  });

  it("the sale's own pickup hand-over cash beside its legs is ordinary counter till cash, counted once, not a hand-over", () => {
    const handedOver = pay({
      amount: 12,
      paymentGroupId: pickupTenderGroupId(ORDER),
      invoice: { orderId: ORDER, order: { counterSale: true } },
    });
    const f = foldDayClose(facts({ payments: [leg(1, 20), handedOver] }));
    expect(f.tillCash).toBe(32);
    expect(f.totals.handOver).toEqual({ count: 0, cash: 0 });
  });
});
