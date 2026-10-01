import { rememberedPricePrefill } from "../lib/cart-line-state";

/** Extracted from NewOrderScreen.addOne (size ratchet, SA-626); behaviour is unchanged. */
describe("rememberedPricePrefill", () => {
  it("pre-fills a one-time discount (below tier) and an upsell (above list), never a tier-equal price", () => {
    expect(rememberedPricePrefill({ lastPrice: 8 }, 12, 10, false)).toBe(8);
    expect(rememberedPricePrefill({ lastPrice: 13 }, 12, 10, false)).toBe(13);
    expect(rememberedPricePrefill({ lastPrice: 10 }, 12, 10, false)).toBeUndefined();
  });

  it("never pre-fills over a SPECIAL tier price, or without history", () => {
    expect(rememberedPricePrefill({ lastPrice: 8 }, 12, 10, true)).toBeUndefined();
    expect(rememberedPricePrefill(undefined, 12, 10, false)).toBeUndefined();
    expect(rememberedPricePrefill(null, 12, 10, false)).toBeUndefined();
  });
});
