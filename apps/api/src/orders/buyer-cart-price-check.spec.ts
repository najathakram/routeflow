import { ConflictException } from "@nestjs/common";
import { assertBuyerCartPricesCurrent } from "./buyer-cart-price-check";

// RF-198 price-race check, lifted verbatim out of OrdersService.create() (4b-2b prefactor). The
// end-to-end behaviour stays pinned by the OrdersService specs; this pins the extracted contract.
const product = { id: "p1", name: "Widget", pricePerUnit: 10, priceTier2: 9 };
const base = {
  role: "CUSTOMER",
  productMap: new Map([["p1", product]]),
  cpMap: new Map<string, number | null>(),
  defaultTier: 1,
  priceHistory: {},
};
const check = (
  over: Record<string, unknown> = {},
  items: unknown[] = [{ productId: "p1", unitPrice: 10 }],
) => assertBuyerCartPricesCurrent({ ...base, items, ...over } as never);

describe("assertBuyerCartPricesCurrent", () => {
  it("passes when every cart price is within a cent of the current effective price", () => {
    expect(() => check()).not.toThrow();
    expect(() => check({}, [{ productId: "p1", unitPrice: 10.005 }])).not.toThrow();
  });

  it("409s with the changed items when a cart price is stale", () => {
    try {
      check({}, [{ productId: "p1", unitPrice: 12 }]);
      fail("expected a ConflictException");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toEqual({
        message: "Prices have been updated. Please review your cart.",
        changedItems: [{ productId: "p1", name: "Widget", cartPrice: 12, currentPrice: 10 }],
      });
    }
  });

  it("compares against the customer's TIER price, and a remembered above-list price is their effective price", () => {
    expect(() => check({ defaultTier: 2 }, [{ productId: "p1", unitPrice: 9 }])).not.toThrow();
    expect(() =>
      check({ priceHistory: { p1: { lastPrice: 11, stickyPrice: 11 } } }, [
        { productId: "p1", unitPrice: 11 },
      ]),
    ).not.toThrow();
  });

  it("B1 (SA-1072): a tier price that came back through history is not the buyer's price", () => {
    // The tier is Retail now, the cart is at 10, and the newest line was SPECIAL at 12, so it was never a chosen price.
    expect(() =>
      check({ priceHistory: { p1: { lastPrice: 12, stickyPrice: null } } }, [
        { productId: "p1", unitPrice: 10 },
      ]),
    ).not.toThrow();
  });

  it("only ever applies to the buyer, and skips lines with no price, no product or an unknown product", () => {
    expect(() => check({ role: "OPERATOR" }, [{ productId: "p1", unitPrice: 99 }])).not.toThrow();
    expect(() =>
      check({}, [{ productId: "p1" }, { unitPrice: 99 }, { productId: "ghost", unitPrice: 99 }]),
    ).not.toThrow();
  });
});
