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
  const legs = [
    { method: "CARD", amount: 30, paymentIds: ["p1"] },
    { method: "CASH", amount: 40, paymentIds: ["p2"] },
  ];

  it("lists every tender line in leg order and drops the single Payment method row", () => {
    const m = build({ payments: legs, change: 10 });
    expect(m.tenderLines).toEqual([
      { key: "0-CARD", label: "Card", amount: 30 },
      { key: "1-CASH", label: "Cash", amount: 40 },
    ]);
    expect(m.methodLabel).toBeNull();
  });

  it("shows the change, and the cash handed over = the cash leg + the change", () => {
    const m = build({ payments: legs, change: 10 });
    expect(m.change).toBe(10);
    expect(m.changeAsEntered).toBe(false);
    expect(m.tendered).toBe(50);
    expect(m.tenderedAsEntered).toBe(false);
  });

  it("an exact split has no change and no tendered row; the Paid figure is the server's", () => {
    const m = build({ payments: legs });
    expect(m).toMatchObject({ change: null, tendered: null, paid: 70, showPaid: true });
  });

  it("card is never read as a tendered cash amount (leg 0 is a card, paid is the sum of both)", () => {
    const m = build({ payments: legs, change: 10 }, 99); // a stale 'entered' figure must not leak into a split
    expect(m.tendered).toBe(50);
    expect(m.tenderedAsEntered).toBe(false);
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
