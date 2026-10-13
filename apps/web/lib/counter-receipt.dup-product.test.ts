import { buildCounterReceipt } from "./counter-receipt";

/**
 * Row 322a (review fold): a cart line is matched to the stored line it was sold as by product + net unit price, EXACT matches
 * for every cart line first, and only then a fallback (the first unused stored line of the product) for a line whose price
 * the server did not store (a re-priced tier). A fallback must never take the stored line a LATER cart line matches exactly.
 */
type Stored = {
  productId: string;
  unitPrice: number;
  originalPrice: number | null;
  priceType: string;
};
const response = (lines: Stored[]) => ({
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 13,
  paid: 13,
  balanceDue: 0,
  method: "CARD" as const,
  paymentRecorded: true,
  lines,
});
const build = (stored: Stored[], cart: Array<{ unitPrice: number }>) =>
  buildCounterReceipt({
    receipt: response(stored),
    lines: cart.map((c, i) => ({
      tempId: `t${i + 1}`,
      productId: "pa",
      name: "Pc",
      qty: 1,
      ...c,
    })),
    enteredTender: null,
    profile: null,
    now: new Date("2026-10-07T15:15:00.000Z"),
  });

// the real case: a STANDARD line with no original beside a DISCOUNTED line of the same product
const plain: Stored = { productId: "pa", unitPrice: 5, originalPrice: null, priceType: "STANDARD" };
const discounted: Stored = {
  productId: "pa",
  unitPrice: 8,
  originalPrice: 12,
  priceType: "DISCOUNTED",
};
const struck = (m: ReturnType<typeof build>) => m.lines.map((l) => l.original);

describe("live receipt: a STANDARD line beside a DISCOUNTED line of one product", () => {
  it("each cart line takes its own stored line when the stored lines arrive in cart order", () => {
    expect(struck(build([plain, discounted], [{ unitPrice: 5 }, { unitPrice: 8 }]))).toEqual([
      null,
      12,
    ]);
  });

  it("...and when they arrive in the OTHER order", () => {
    expect(struck(build([discounted, plain], [{ unitPrice: 5 }, { unitPrice: 8 }]))).toEqual([
      null,
      12,
    ]);
    expect(struck(build([discounted, plain], [{ unitPrice: 8 }, { unitPrice: 5 }]))).toEqual([
      12,
      null,
    ]);
  });

  it("a fallback never steals the line a LATER cart line matches exactly (server re-priced line A, line B DISCOUNTED)", () => {
    // A was rung at 4.99 but stored at 5.00 (no exact match); B is the 8.00 DISCOUNTED line. B's stored line is served FIRST.
    const m = build([discounted, plain], [{ unitPrice: 4.99 }, { unitPrice: 8 }]);
    expect(struck(m)).toEqual([null, 12]);
    expect(m.discounts).toBe(4);
  });

  it("...and with the exact line served last, the re-priced line still falls back to the OTHER stored line", () => {
    const m = build([plain, discounted], [{ unitPrice: 4.99 }, { unitPrice: 8 }]);
    expect(struck(m)).toEqual([null, 12]);
  });

  it("two identical lines (same product, same price) take one stored line each, in served order", () => {
    const a = { ...plain, originalPrice: 9, priceType: "DISCOUNTED" };
    const b = { ...plain, originalPrice: 7, priceType: "DISCOUNTED" };
    expect(struck(build([a, b], [{ unitPrice: 5 }, { unitPrice: 5 }]))).toEqual([9, 7]);
  });

  it("a cart price the server did not store falls back to the first unused line of the product", () => {
    const m = build(
      [{ ...plain, originalPrice: 9, priceType: "DISCOUNTED" }],
      [{ unitPrice: 4.99 }],
    );
    expect(struck(m)).toEqual([9]);
  });

  it("a line of a product the server did not store gets nothing struck", () => {
    const m = buildCounterReceipt({
      receipt: response([plain]),
      lines: [{ tempId: "t1", productId: "other", name: "X", unitPrice: 5, qty: 1 }],
      enteredTender: null,
      profile: null,
      now: new Date("2026-10-07T15:15:00.000Z"),
    });
    expect(m.lines[0].original).toBeNull();
  });
});
