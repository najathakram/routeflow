/**
 * B1094 cross-customer guard: the buyer's Idempotency-Key is customer-scoped on the server, so the
 * module-level key must never survive a logout or a seller switch, and a different scope (buyer
 * account + active seller) is a different cart even when the payload is identical.
 */
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({}) },
}));

import { clearActiveSeller, buyerLogout, storeActiveSeller, type BuyerSeller } from "./buyer-auth";
import { buyerSubmitKeyFor, clearBuyerSubmitKey } from "./api/buyer-submit-key";

const seller = (id: string) =>
  ({ linkId: `l-${id}`, linkStatus: "ACTIVE", tenant: { id } }) as unknown as BuyerSeller;
const cart = { items: [{ productId: "p1", qty: 3 }] };

describe("buyer submit key never crosses a customer", () => {
  beforeEach(() => {
    localStorage.clear();
    clearBuyerSubmitKey();
  });

  it("logout drops the key: the next buyer's identical cart mints a new one", async () => {
    const before = buyerSubmitKeyFor(cart);
    await buyerLogout();
    expect(buyerSubmitKeyFor(cart)).not.toBe(before);
  });

  it("switching seller (store or clear) drops the key", () => {
    const k1 = buyerSubmitKeyFor(cart);
    storeActiveSeller(seller("t-2"));
    const k2 = buyerSubmitKeyFor(cart);
    expect(k2).not.toBe(k1);
    clearActiveSeller();
    expect(buyerSubmitKeyFor(cart)).not.toBe(k2);
  });

  it("the same cart under a different buyer/seller scope never shares a key, with no clear in between", () => {
    expect(buyerSubmitKeyFor(cart, "buyer-1|t-1")).not.toBe(buyerSubmitKeyFor(cart, "buyer-2|t-1"));
    expect(buyerSubmitKeyFor(cart, "buyer-2|t-1")).not.toBe(buyerSubmitKeyFor(cart, "buyer-2|t-2"));
  });
});
