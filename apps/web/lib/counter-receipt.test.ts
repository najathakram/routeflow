import { roundMoney } from "@routeflow/pricing";
import { buildCounterReceipt, formatReceiptMoney, type ReceiptLineInput } from "./counter-receipt";

const NOW = new Date("2026-10-07T15:30:00Z");
const PLAIN: ReceiptLineInput = { tempId: "a", name: "Cola", unitPrice: 2.5, qty: 3 };
const BOXED: ReceiptLineInput = {
  tempId: "b",
  name: "Water",
  unitPrice: 12,
  qty: 15,
  unitsPerBox: 12,
  boxes: 1,
  pieces: 3,
};
const sale = (over: Record<string, unknown> = {}) => ({
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 22.5,
  paid: 22.5,
  balanceDue: 0,
  paymentRecorded: true,
  method: "CASH" as const,
  ...over,
});
const build = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  buildCounterReceipt({
    receipt: sale(over) as never,
    lines: [PLAIN, BOXED],
    enteredTender: null,
    profile: null,
    now: NOW,
    ...extra,
  });

describe("buildCounterReceipt", () => {
  it("prices a plain line as qty x unit = total and a boxed line through the pricing package", () => {
    const m = build();
    expect(m.lines[0]).toMatchObject({ name: "Cola", total: 7.5 });
    expect(m.lines[0].detail).toBe("3 × $2.50");
    // 1 box + 3 pcs of 12 at $12/box = 12 + 3 = 15, never 15 * 12
    expect(m.lines[1]).toMatchObject({ name: "Water", total: 15 });
    expect(m.lines[1].detail).toBe("1 box + 3 pcs × $12.00 per box");
  });

  it("header: name, address and phone from the settings answer; name only when that is all there is", () => {
    const full = build(
      {},
      {
        profile: {
          businessName: "Acme Foods",
          street: "1 Main St",
          city: "Springfield",
          state: "IL",
          zip: "62701",
          phone: "555-0100",
        },
      },
    );
    expect(full.header).toEqual({
      name: "Acme Foods",
      addressLines: ["1 Main St", "Springfield, IL 62701"],
      phone: "555-0100",
    });
    const nameOnly = build(
      {},
      { profile: { businessName: "Acme Foods", street: "  ", phone: "" } },
    );
    expect(nameOnly.header).toEqual({ name: "Acme Foods", addressLines: [], phone: null });
    expect(build().header).toEqual({ name: null, addressLines: [], phone: null });
  });

  it("number and date", () => {
    const m = build();
    expect(m.orderNumber).toBe("ORD-1");
    expect(m.invoiceNumber).toBe("INV-1");
    expect(m.dateLabel).toMatch(/2026/);
  });

  it("cash with change: tendered = paid + change", () => {
    const m = build({ paid: 22.5, change: 7.5 });
    expect(m.methodLabel).toBe("Cash");
    expect(m.tendered).toBe(30);
    expect(m.change).toBe(7.5);
    expect(m.changeAsEntered).toBe(false);
  });

  it("cash with zero change: tendered shown, no change figure", () => {
    const m = build({ paid: 22.5 });
    expect(m.tendered).toBe(22.5);
    expect(m.change).toBeNull();
  });

  it("card: paid and method, no change", () => {
    const m = build({ method: "CARD", paid: 22.5 });
    expect(m.methodLabel).toBe("Card");
    expect(m.tendered).toBeNull();
    expect(m.change).toBeNull();
  });

  it("recovered cash sale uses the entered tender, labelled as entered", () => {
    const m = build({ paid: 22.5 }, { enteredTender: 40 });
    expect(m.tendered).toBe(40);
    expect(m.change).toBe(17.5);
    expect(m.changeAsEntered).toBe(true);
  });

  it("on account and payment-not-recorded show no tender", () => {
    const acct = build({ method: "ON_ACCOUNT", paid: 0, balanceDue: 22.5 });
    expect(acct.onAccount).toBe(true);
    expect(acct.tendered).toBeNull();
    const bad = build({ paymentRecorded: false, paid: 0, balanceDue: 22.5 });
    expect(bad.paymentNotRecorded).toBe(true);
    expect(bad.methodLabel).toBeNull();
    expect(bad.tendered).toBeNull();
  });

  it("formats money", () => {
    expect(formatReceiptMoney(2.5)).toBe("$2.50");
  });

  it("subtotal + adjustment reconcile to the server total, also for a repriced sale", () => {
    const same = build({ total: 22.5 });
    expect(same.subtotal).toBe(22.5);
    expect(same.adjustment).toBe(0);
    const repriced = build({ total: 24.75, paid: 24.75 });
    expect(repriced.subtotal).toBe(22.5);
    expect(repriced.adjustment).toBe(2.25);
    expect(roundMoney(repriced.subtotal + repriced.adjustment)).toBe(repriced.total);
  });

  it("falls back to the rung method when the response has none; carries the cashier", () => {
    const m = build(
      { method: undefined, paid: 22.5, change: 7.5 },
      { fallbackMethod: "CASH", cashier: " pat " },
    );
    expect(m.methodLabel).toBe("Cash");
    expect(m.tendered).toBe(30);
    expect(m.cashier).toBe("pat");
  });
});
