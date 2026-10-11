import { buildCounterReceipt, type ReceiptLineInput } from "./counter-receipt";

/** The counter receipt of a split payment: one line per tender leg, the cash handed over and the change; the not-recorded why. */

const NOW = new Date("2026-10-07T15:30:00Z");
const LINE: ReceiptLineInput = { tempId: "a", name: "Big Order", unitPrice: 70, qty: 1 };
const sale = (over: Record<string, unknown> = {}) => ({
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 70,
  paid: 70,
  balanceDue: 0,
  paymentRecorded: true,
  method: "CARD" as const,
  ...over,
});
const build = (over: Record<string, unknown> = {}, enteredTender: number | null = null) =>
  buildCounterReceipt({
    receipt: sale(over) as never,
    lines: [LINE],
    enteredTender,
    profile: null,
    now: NOW,
  });

describe("a split-payment receipt", () => {
  // stored in the clerk's order (cash first here): the receipt lists non-cash first, then cash
  const legs = [
    { method: "CASH", amount: 40, paymentIds: ["p2"] },
    { method: "CARD", amount: 30, paymentIds: ["p1"] },
  ];

  it("lists one row per leg, non-cash first then cash, and labels the method 'Card + Cash'", () => {
    const m = build({ payments: legs });
    expect(m.tenderLines.map((t) => [t.label, t.amount])).toEqual([
      ["Card", 30],
      ["Cash", 40],
    ]);
    expect(m.methodLabel).toBe("Card + Cash");
  });

  it("card 30 + cash 50 on 70: Card $30.00 / Cash $50.00 (handed over) / Change $10.00; no separate Tendered row", () => {
    const m = build({ payments: legs, change: 10 });
    expect(m.tenderLines.map((t) => [t.label, t.amount])).toEqual([
      ["Card", 30],
      ["Cash", 50],
    ]);
    expect(m.change).toBe(10);
    expect(m.changeAsEntered).toBe(false);
    expect(m.tendered).toBeNull();
  });

  it("an exact live split has no change row; the Cash line is what was applied; Paid is the server's", () => {
    const m = build({ payments: legs });
    expect(m).toMatchObject({ change: null, tendered: null, paid: 70, showPaid: true });
    expect(m.tenderLines[1]).toMatchObject({ label: "Cash", amount: 40 });
  });

  it("a stale 'entered' figure never leaks into a live split that has its own change", () => {
    const m = build({ payments: legs, change: 10 }, 99);
    expect(m.tenderLines[1].amount).toBe(50);
    expect(m.changeAsEntered).toBe(false);
  });

  it("a recovered split sale (by-key never carries change) shows the cash entered and the change as entered", () => {
    const m = build({ payments: legs }, 50);
    expect(m.tenderLines[1].amount).toBe(50);
    expect(m).toMatchObject({ change: 10, changeAsEntered: true });
  });

  it("a recovered split sale with no change owed shows nothing extra", () => {
    const m = build({ payments: legs }, 40);
    expect(m.tenderLines[1].amount).toBe(40);
    expect(m.change).toBeNull();
  });

  it("a single tender is unchanged: no tender lines, the one Payment method row", () => {
    const m = build({
      method: "CASH",
      paid: 70,
      change: 10,
      payments: [{ method: "CASH", amount: 70, paymentIds: [] }],
    });
    expect(m.tenderLines).toEqual([]);
    expect(m.methodLabel).toBe("Cash");
    expect(m.tendered).toBe(80);
  });

  it("payment not recorded with COUNTER_PAYMENT_EXCEEDS_TOTAL says the balance changed; any other code says nothing extra", () => {
    const why = build({
      paymentRecorded: false,
      paid: 0,
      balanceDue: 70,
      paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
    });
    expect(why.paymentNotRecorded).toBe(true);
    expect(why.paymentNotRecordedCopy).toBe("The balance changed — take the payment again");
    expect(why.tenderLines).toEqual([]);
    const other = build({ paymentRecorded: false, paid: 0, balanceDue: 70, paymentErrorCode: "X" });
    expect(other.paymentNotRecordedCopy).toBeNull();
  });
});
