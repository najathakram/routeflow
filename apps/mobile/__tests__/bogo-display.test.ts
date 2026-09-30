/**
 * BUY_N_GET_M ("buy N, get the next M free") mobile display parity — the pure
 * helpers in `lib/buyer-cart-logic.ts`, plus their wiring through
 * `buyer-cart-pricing.priceCart` (cart lines) and `catalog-tile-logic`
 * (catalog tile). Money-critical assertions pin the owner's exact quantity
 * table and the exact-subtotal rule (never a rounded net-unit-price — see
 * `pricing.ts`'s header on why `$35 × 5/6` rounding would drift a cent).
 */
import {
  bogoBannerText,
  BOGO_FALLBACK_BANNER,
  freeUnitsLabel,
  matchingBogoPromo,
  sellingUnits,
} from "../lib/buyer-cart-logic";
import { priceCart, promoRulesFrom, type CartLineInput } from "../lib/buyer-cart-pricing";
import { bogoTileChip, deriveTilePrice } from "../lib/catalog-tile-logic";
import type { BuyerPromotion } from "../lib/api/buyer";

/**
 * `BuyerPromotion.type` (`lib/api/buyer.ts`) is a narrower API-response union
 * that predates BUY_N_GET_M and hasn't itself been widened to include it (that
 * file is outside this package's file scope — see the WP4 report's
 * deviations). `as unknown as BuyerPromotion` is the standard TS escape hatch
 * for a literal outside a field's declared union; it does not change the
 * fixture's actual shape.
 */
function bogoPromo(overrides: Partial<BuyerPromotion> = {}): BuyerPromotion {
  return {
    id: "bogo1",
    name: "Buy 5 get 1 free",
    bannerText: null,
    type: "BUY_N_GET_M",
    value: 1, // M — free quantity
    minQty: 5, // N — buy quantity
    scope: "ALL",
    category: null,
    startsAt: "2026-01-01",
    endsAt: "2026-12-31",
    productIds: [],
    ...overrides,
  } as unknown as BuyerPromotion;
}

describe("sellingUnits", () => {
  it("boxed line: counts only whole boxes", () => {
    expect(sellingUnits({ qty: 64, boxes: 5, pieces: 40, unitsPerBox: 12 })).toBe(5);
  });

  it("boxed line: loose pieces NEVER count, even a full box's worth of them", () => {
    expect(sellingUnits({ qty: 40, boxes: 0, pieces: 40, unitsPerBox: 12 })).toBe(0);
  });

  it("non-boxed line: uses qty (pieces) directly", () => {
    expect(sellingUnits({ qty: 12, unitsPerBox: null })).toBe(12);
  });

  it("never negative", () => {
    expect(sellingUnits({ qty: -3, unitsPerBox: null })).toBe(0);
    expect(sellingUnits({ qty: 5, boxes: -2, unitsPerBox: 12 })).toBe(0);
  });
});

describe("freeUnitsLabel", () => {
  it("0 / null / undefined → no label (never render an empty chip)", () => {
    expect(freeUnitsLabel(0)).toBeNull();
    expect(freeUnitsLabel(null)).toBeNull();
    expect(freeUnitsLabel(undefined)).toBeNull();
  });

  it("positive → 'N free'", () => {
    expect(freeUnitsLabel(1)).toBe("1 free");
    expect(freeUnitsLabel(2)).toBe("2 free");
  });
});

describe("bogoBannerText", () => {
  it("uses the promo's own bannerText when set", () => {
    expect(bogoBannerText({ bannerText: "Buy 5, get 1 free!" })).toBe("Buy 5, get 1 free!");
  });

  it("falls back on whitespace-only bannerText", () => {
    expect(bogoBannerText({ bannerText: "   " })).toBe(BOGO_FALLBACK_BANNER);
  });

  it("falls back when bannerText is null", () => {
    expect(bogoBannerText({ bannerText: null })).toBe(BOGO_FALLBACK_BANNER);
  });
});

describe("matchingBogoPromo", () => {
  it("ALL scope matches any product", () => {
    const promo = matchingBogoPromo([bogoPromo()], { productId: "x", category: "Snacks" });
    expect(promo?.id).toBe("bogo1");
  });

  it("CATEGORY scope matches only the same category", () => {
    const promos = [bogoPromo({ scope: "CATEGORY", category: "Drinks" })];
    expect(matchingBogoPromo(promos, { productId: "x", category: "Drinks" })?.id).toBe("bogo1");
    expect(matchingBogoPromo(promos, { productId: "x", category: "Snacks" })).toBeNull();
  });

  it("PRODUCTS scope matches only the listed ids", () => {
    const promos = [bogoPromo({ scope: "PRODUCTS", productIds: ["a", "b"] })];
    expect(matchingBogoPromo(promos, { productId: "a" })?.id).toBe("bogo1");
    expect(matchingBogoPromo(promos, { productId: "z" })).toBeNull();
  });

  it("ignores non-BUY_N_GET_M promos entirely, even a scope-matching one", () => {
    const promos = [bogoPromo({ id: "percent1", type: "PERCENT", scope: "ALL" })];
    expect(matchingBogoPromo(promos, { productId: "x" })).toBeNull();
  });

  it("undefined promos → null", () => {
    expect(matchingBogoPromo(undefined, { productId: "x" })).toBeNull();
  });

  it("ties between multiple matching BOGO promos break by id (lowest wins, same as applyBestPromotion)", () => {
    const promos = [bogoPromo({ id: "zzz" }), bogoPromo({ id: "aaa" })];
    expect(matchingBogoPromo(promos, { productId: "x" })?.id).toBe("aaa");
  });
});

describe("priceCart: BUY_N_GET_M free-units wiring (owner's exact table)", () => {
  const rules = promoRulesFrom([bogoPromo({ minQty: 5, value: 1, scope: "ALL" })]);

  it.each([
    [5, 0],
    [6, 1],
    [11, 1],
    [12, 2],
    [18, 3],
  ])("qty %i selling units → %i free", (qty, expectedFree) => {
    const line: CartLineInput = { productId: "p", category: null, unitPrice: 10, qty };
    const r = priceCart([line], rules);
    expect(r.lines[0].freeUnits).toBe(expectedFree);
  });

  it("unit price is never faked: net stays the base price, no strikethrough", () => {
    const line: CartLineInput = { productId: "p", category: null, unitPrice: 10, qty: 12 };
    const r = priceCart([line], rules);
    expect(r.lines[0].net).toBe(10);
    expect(r.lines[0].original).toBeNull();
  });

  it("boxed line: 12 boxes @ $35, 2 free → exact $350.00, never a rounded net-unit-price", () => {
    const line: CartLineInput = {
      productId: "case",
      category: null,
      unitPrice: 35,
      qty: 72, // 12 boxes × 6 pieces
      boxes: 12,
      pieces: 0,
      unitsPerBox: 6,
    };
    const r = priceCart([line], rules);
    expect(r.lines[0].freeUnits).toBe(2);
    expect(r.lines[0].lineSubtotal).toBe(350);
    expect(r.lines[0].lineOriginalSubtotal).toBe(420);
    expect(r.savings).toBe(70);
    // A rounded net-unit-price ($35 × 5/6 = $29.1667 → $29.17) drifts a cent
    // when multiplied back across 12 units — the real result must NOT match it.
    expect(r.lines[0].lineSubtotal).not.toBeCloseTo(29.17 * 12, 2);
  });

  it("pieces NEVER count: 5 boxes + 40 loose pieces stays 0 free until the 6th whole box", () => {
    const line: CartLineInput = {
      productId: "case",
      category: null,
      unitPrice: 35,
      qty: 5 * 6 + 40,
      boxes: 5,
      pieces: 40,
      unitsPerBox: 6,
    };
    const r = priceCart([line], rules);
    expect(r.lines[0].freeUnits).toBe(0);
    expect(r.lines[0].lineSubtotal).toBe(r.lines[0].lineOriginalSubtotal);
  });

  it("existing PERCENT promo behavior is unaffected: freeUnits is 0, savings unchanged", () => {
    const percentRules = promoRulesFrom([
      {
        id: "pc1",
        name: "10% off",
        bannerText: null,
        type: "PERCENT",
        value: 10,
        minQty: null,
        scope: "ALL",
        category: null,
        startsAt: "2026-01-01",
        endsAt: "2026-12-31",
        productIds: [],
      },
    ]);
    const line: CartLineInput = { productId: "soda", category: null, unitPrice: 10, qty: 3 };
    const r = priceCart([line], percentRules);
    expect(r.lines[0].freeUnits).toBe(0);
    expect(r.lines[0].net).toBe(9);
    expect(r.savings).toBe(3);
  });
});

describe("deriveTilePrice + bogoTileChip: tile parity with the cart", () => {
  const product = { id: "case", buyerPrice: 35, category: "Drinks", unitsPerBox: 6 };
  const rules = promoRulesFrom([bogoPromo({ minQty: 5, value: 1, scope: "ALL" })]);

  it("tile shows the BOGO chip even at the default (pre-cart) qty, where freeUnits is still 0", () => {
    const priced = deriveTilePrice(product, rules, undefined);
    expect(priced.freeUnits).toBe(0); // default add qty is 1 box, below the 6-box block
    expect(priced.unitPrice).toBe(35);
    expect(priced.originalPrice).toBeNull();

    const chip = bogoTileChip(product, [bogoPromo({ minQty: 5, value: 1, scope: "ALL" })]);
    expect(chip).toEqual({ kind: "deal", label: BOGO_FALLBACK_BANNER });
  });

  it("chip shows the promo's own bannerText when the admin set one", () => {
    const chip = bogoTileChip(product, [
      bogoPromo({ minQty: 5, value: 1, scope: "ALL", bannerText: "Buy 5, get 1 free!" }),
    ]);
    expect(chip).toEqual({ kind: "deal", label: "Buy 5, get 1 free!" });
  });

  it("no matching BOGO promo → null chip", () => {
    expect(bogoTileChip(product, [])).toBeNull();
    expect(bogoTileChip(product, undefined)).toBeNull();
  });

  it("reproduces the cart's freeUnits exactly for the same boxed cart line (money anchor)", () => {
    const cartItem = {
      productId: "case",
      name: "Case",
      unitPrice: 35,
      qty: 72,
      category: "Drinks",
      unitsPerBox: 6,
      boxes: 12,
      pieces: 0,
    };
    const priced = deriveTilePrice(product, rules, cartItem);

    const cartLine: CartLineInput = {
      productId: "case",
      category: "Drinks",
      unitPrice: 35,
      qty: 72,
      boxes: 12,
      pieces: 0,
      unitsPerBox: 6,
    };
    const cart = priceCart([cartLine], rules);

    expect(priced.freeUnits).toBe(cart.lines[0].freeUnits);
    expect(priced.freeUnits).toBe(2);
    expect(priced.unitPrice).toBe(cart.lines[0].net);
    expect(priced.originalPrice).toBe(cart.lines[0].original);
  });
});
