import { readLiveCart, writeLiveCart } from "./counter-live-cart";
import { kindOfPick } from "../app/(dashboard)/orders/_components/counter-buyer-choice";

/**
 * CQ-02: the live cart is what a refresh restores. The customer is kept to the fields the till re-renders; the tax
 * exemption is one of them, or a restored cart would add tax the order and invoice do not carry.
 */
const KEY = "rf.counterSale.liveCart:acme:u-a";
const snap = (customer: Record<string, unknown> | null) =>
  ({
    lines: [{ tempId: "t", productId: "p1", name: "Cola", unitPrice: 10, qty: 1 }],
    customer,
    method: "CASH",
    tendered: "",
    reference: "",
  }) as never;

describe("live cart persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the tax exemption and drops everything else about the customer", () => {
    writeLiveCart(
      KEY,
      snap({ id: "c1", businessName: "Acme", isTaxExempt: true, email: "a@b.c", phone: "555" }),
      "u-a",
    );
    const stored = JSON.parse(window.localStorage.getItem(KEY) as string).customer;
    expect(stored).toEqual({ id: "c1", businessName: "Acme", isTaxExempt: true });
    expect(readLiveCart(KEY)?.customer).toEqual(stored);
  });

  it("keeps the walk-in customer record's isWalkIn, so a refresh restores a Walk-in, not a named customer (#3610 review)", () => {
    writeLiveCart(KEY, snap({ id: "w1", businessName: "Walk-in customer", isWalkIn: true }), "u-a");
    const restored = readLiveCart(KEY)?.customer as { isWalkIn?: boolean } | null;
    expect(restored).toEqual({ id: "w1", businessName: "Walk-in customer", isWalkIn: true });
    expect(kindOfPick(restored!)).toBe("walk-in");
  });

  it("does not store isWalkIn for a named customer", () => {
    writeLiveCart(KEY, snap({ id: "c1", businessName: "Acme", isWalkIn: false }), "u-a");
    expect(JSON.parse(window.localStorage.getItem(KEY) as string).customer).toEqual({
      id: "c1",
      businessName: "Acme",
    });
  });
});
