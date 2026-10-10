import { buyerSubmitKeyFor, clearBuyerSubmitKey } from "../lib/buyer-submit-key";

// B1094: the key follows the cart, so a double tap / timeout retry sends the same Idempotency-Key.
describe("buyerSubmitKeyFor", () => {
  const cart = () => ({ items: [{ productId: "p1", qty: 3 }], notes: "n" });
  beforeEach(() => clearBuyerSubmitKey());

  it("the same cart submitted twice (double tap) gets the same key", () => {
    expect(buyerSubmitKeyFor(cart())).toBe(buyerSubmitKeyFor(cart()));
  });

  it("an edited cart is a different cart: a new key", () => {
    const first = buyerSubmitKeyFor(cart());
    expect(buyerSubmitKeyFor({ items: [{ productId: "p1", qty: 4 }] })).not.toBe(first);
  });

  it("after a successful submit the next cart mints a fresh key", () => {
    const first = buyerSubmitKeyFor(cart());
    clearBuyerSubmitKey();
    expect(buyerSubmitKeyFor(cart())).not.toBe(first);
  });

  it("is a bounded printable token the server accepts (<= 128 chars, no spaces)", () => {
    expect(buyerSubmitKeyFor(cart())).toMatch(/^[\x21-\x7e]{1,128}$/);
  });
});
