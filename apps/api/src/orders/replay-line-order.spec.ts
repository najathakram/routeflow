import { assertReplaySameCart } from "./replay-same-cart";
import { assertReplaySamePrices } from "./counter-sale/counter-sale-replay-price";

/**
 * W-1187 PR-2b (SA-W872 pin): the staff now drag a cart's lines into any order before Complete, so a resend under the same
 * Idempotency-Key can carry the SAME lines in ANOTHER order (an offline retry after a reorder). The replay compare is
 * order-blind (a multiset of lines), so it is a replay, not a CART_MISMATCH, and the answer is the FIRST sale with the
 * order it stored. If either compare ever became order-sensitive, a reordered retry would 409 instead of finding its sale.
 */
const stored = [
  { productId: "p-a", name: "A", qty: 1, unitPrice: 2, status: "PENDING" },
  { productId: "p-b", name: "B", qty: 2, unitPrice: 3, status: "PENDING" },
  { productId: "p-c", name: "C", qty: 3, unitPrice: 4, status: "PENDING" },
];

describe("an Idempotency-Key replay with the lines in another order", () => {
  it("assertReplaySameCart: the same lines reordered is a replay (no throw)", () => {
    const existing = { id: "o1", status: "PENDING", lineItems: stored };
    const reordered = {
      items: [
        { productId: "p-c", qty: 3 },
        { productId: "p-a", qty: 1 },
        { productId: "p-b", qty: 2 },
      ],
    };
    expect(() => assertReplaySameCart(existing, reordered)).not.toThrow();
  });

  it("assertReplaySameCart: a changed quantity is still a mismatch", () => {
    const existing = { id: "o1", status: "PENDING", lineItems: stored };
    const changed = {
      items: [
        { productId: "p-c", qty: 9 },
        { productId: "p-a", qty: 1 },
        { productId: "p-b", qty: 2 },
      ],
    };
    expect(() => assertReplaySameCart(existing, changed)).toThrow();
  });

  it("assertReplaySamePrices: the counter's price half is order-blind too", () => {
    const existing = { id: "o1", lineItems: stored } as never;
    const items = [
      { productId: "p-c", qty: 3, unitPrice: 4 },
      { productId: "p-a", qty: 1, unitPrice: 2 },
      { productId: "p-b", qty: 2, unitPrice: 3 },
    ] as never;
    expect(() => assertReplaySamePrices(existing, items)).not.toThrow();
  });

  it("assertReplaySamePrices: a changed price is still a mismatch", () => {
    const existing = { id: "o1", lineItems: stored } as never;
    const items = [
      { productId: "p-c", qty: 3, unitPrice: 4 },
      { productId: "p-a", qty: 1, unitPrice: 2.5 },
      { productId: "p-b", qty: 2, unitPrice: 3 },
    ] as never;
    expect(() => assertReplaySamePrices(existing, items)).toThrow();
  });
});
