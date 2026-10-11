import { buildCounterReceipt } from "./counter-receipt";

/**
 * Row 322a: two cart lines of ONE product at different prices each take their OWN stored line (product + net unit price),
 * whatever order the server serves the stored lines in. Matching by product alone struck the wrong list price.
 */
const response = (lines: Array<Record<string, unknown>>) => ({
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 13,
  paid: 13,
  balanceDue: 0,
  method: "CARD" as const,
  paymentRecorded: true,
  lines: lines as never,
});
const cart = [
  { tempId: "t1", productId: "pa", name: "Pc", unitPrice: 5, qty: 1 },
  { tempId: "t2", productId: "pa", name: "Pc", unitPrice: 8, qty: 1 },
];
const build = (stored: Array<Record<string, unknown>>) =>
  buildCounterReceipt({
    receipt: response(stored),
    lines: cart,
    enteredTender: null,
    profile: null,
    now: new Date("2026-10-07T15:15:00.000Z"),
  });

describe("live receipt: duplicate products at different prices", () => {
  const five = { productId: "pa", unitPrice: 5, originalPrice: 9, priceType: "DISCOUNTED" };
  const eight = { productId: "pa", unitPrice: 8, originalPrice: 12, priceType: "DISCOUNTED" };

  it("each cart line strikes its own list price when the stored lines arrive in cart order", () => {
    const m = build([five, eight]);
    expect(m.lines[0]).toMatchObject({ total: 5, original: 9, discount: 4 });
    expect(m.lines[1]).toMatchObject({ total: 8, original: 12, discount: 4 });
  });

  it("...and when they arrive in the OTHER order", () => {
    const m = build([eight, five]);
    expect(m.lines[0]).toMatchObject({ total: 5, original: 9, discount: 4 });
    expect(m.lines[1]).toMatchObject({ total: 8, original: 12, discount: 4 });
  });

  it("two identical lines (same product, same price) still take one stored line each", () => {
    const m = buildCounterReceipt({
      receipt: response([five, { ...five, originalPrice: 7 }]),
      lines: [
        { tempId: "t1", productId: "pa", name: "Pc", unitPrice: 5, qty: 1 },
        { tempId: "t2", productId: "pa", name: "Pc", unitPrice: 5, qty: 1 },
      ],
      enteredTender: null,
      profile: null,
      now: new Date("2026-10-07T15:15:00.000Z"),
    });
    expect(m.lines.map((l) => l.original)).toEqual([9, 7]);
  });

  it("a cart price the server did not store (a re-priced tier) falls back to the first unused line of the product", () => {
    const m = buildCounterReceipt({
      receipt: response([five]),
      lines: [{ tempId: "t1", productId: "pa", name: "Pc", unitPrice: 4.99, qty: 1 }],
      enteredTender: null,
      profile: null,
      now: new Date("2026-10-07T15:15:00.000Z"),
    });
    expect(m.lines[0]).toMatchObject({ original: 9 });
  });
});
