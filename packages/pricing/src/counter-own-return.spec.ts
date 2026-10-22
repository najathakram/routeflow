import { isOwnReturn, ownReturnedAmount } from "./counter-own-return";

/**
 * B1262 / SA-838 (review I1): "this order's own return" is ONE predicate for the tender provenance and for the Returned line.
 * A STANDARD return is the order's when filed on it; an INLINE return is the order's only through an item sold on it (it is
 * usually filed on ANOTHER order). The money of an INLINE return is its own items' priced amounts, never prorated.
 */
const item = (
  sourceOrderId: string | null,
  subtotal: unknown,
  taxAmount?: unknown,
  categoryTax?: unknown,
) => ({
  sourceOrderId,
  subtotal,
  taxAmount,
  categoryTax,
});

describe("isOwnReturn", () => {
  it("a STANDARD return is its order's; a return with no kind reads STANDARD", () => {
    expect(isOwnReturn("a", { kind: "STANDARD", orderId: "a" })).toBe(true);
    expect(isOwnReturn("a", { orderId: "a" })).toBe(true);
    expect(isOwnReturn("a", { kind: "STANDARD", orderId: "b" })).toBe(false);
  });

  it("an INLINE return is the order's only through an item sourced from it, wherever it is filed", () => {
    expect(isOwnReturn("a", { kind: "INLINE", orderId: "b", items: [item("a", 1)] })).toBe(true);
    expect(isOwnReturn("a", { kind: "INLINE", orderId: "a", items: [item("a", 1)] })).toBe(true);
    expect(isOwnReturn("a", { kind: "INLINE", orderId: "a", items: [item("z", 1)] })).toBe(false);
    expect(isOwnReturn("a", { kind: "INLINE", orderId: "a", items: [item(null, 1)] })).toBe(false);
    expect(isOwnReturn("a", { kind: "INLINE", orderId: "a" })).toBe(false);
  });
});

describe("ownReturnedAmount", () => {
  it("a STANDARD return filed on the order is worth its amount", () => {
    expect(ownReturnedAmount("a", [{ orderId: "a", amount: 6.25 }])).toBe(6.25);
  });

  it("the sale's own INLINE return, filed on a carrier order, counts for the sale and not for the carrier", () => {
    const inline = {
      kind: "INLINE",
      orderId: "b",
      amount: 99,
      items: [item("a", "5.00", "0.40", "0.10"), item("a", "1.00", "0.08", null)],
    };
    expect(ownReturnedAmount("a", [inline])).toBe(6.58);
    expect(ownReturnedAmount("b", [inline])).toBe(0);
  });

  it("an INLINE return mixing two sales counts only the items sold on this one (never prorated)", () => {
    const inline = {
      kind: "INLINE",
      orderId: "c",
      items: [item("a", "4.00", "0.32"), item("b", "7.00", "0.56")],
    };
    expect(ownReturnedAmount("a", [inline])).toBe(4.32);
    expect(ownReturnedAmount("b", [inline])).toBe(7.56);
  });

  it("sums in cents across returns and ignores everything that is not the order's", () => {
    expect(
      ownReturnedAmount("a", [
        { orderId: "a", amount: 0.1 },
        { orderId: "a", amount: 0.2 },
        { orderId: "other", amount: 50 },
        { kind: "INLINE", orderId: "a", items: [item("z", 40)] },
      ]),
    ).toBe(0.3);
  });

  it("an item with no priced amount counts as zero, and no returns is zero", () => {
    expect(
      ownReturnedAmount("a", [{ kind: "INLINE", orderId: "b", items: [item("a", null)] }]),
    ).toBe(0);
    expect(ownReturnedAmount("a", [])).toBe(0);
  });
});
