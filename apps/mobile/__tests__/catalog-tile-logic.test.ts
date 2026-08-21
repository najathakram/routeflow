/**
 * Catalogue-v2 tile logic (P5-16a) — pure functions behind the mobile buyer
 * catalog tile. The money-critical assertion is the tile↔cart cent-parity
 * check in `deriveTilePrice`: it must reproduce exactly what
 * `buyer-cart-pricing.priceCart` (the cart's own pricer) computes for the
 * same line, since both ultimately bill what the server will charge.
 */
import {
  alertIdSet,
  behaviorLabel,
  computeTileChip,
  deriveTilePrice,
  stockLabel,
  tileCta,
} from "../lib/catalog-tile-logic";
import { priceCart, type CartLineInput } from "../lib/buyer-cart-pricing";
import type { PromotionRule, PromoResult } from "../lib/pricing";
import type { CartItem } from "../store/cartStore";
import type { BuyerStockAlerts, ReplenishmentEstimate } from "../lib/api/buyer";

function estimate(overrides: Partial<ReplenishmentEstimate> = {}): ReplenishmentEstimate {
  return {
    productId: "p1",
    name: "Product",
    unit: "ea",
    unitsPerBox: null,
    imageKey: null,
    lastOrderedAt: "2026-01-01",
    orderCount: 3,
    cadenceDays: null,
    daysSinceLast: 5,
    estDaysLeft: null,
    typicalQty: 1,
    suggestedQty: 1,
    state: "ok",
    ...overrides,
  };
}

describe("tileCta", () => {
  it("out of stock, not in cart → notify", () => {
    expect(tileCta({ stockStatus: "OUT_OF_STOCK" }, 0)).toBe("notify");
  });

  it("in cart (units > 0) → stepper, even when now OOS", () => {
    expect(tileCta({ stockStatus: "OUT_OF_STOCK" }, 3)).toBe("stepper");
    expect(tileCta({ stockStatus: "IN_STOCK" }, 1)).toBe("stepper");
  });

  it("in stock or low, not in cart → add", () => {
    expect(tileCta({ stockStatus: "IN_STOCK" }, 0)).toBe("add");
    expect(tileCta({ stockStatus: "LOW" }, 0)).toBe("add");
  });

  it("missing stockStatus defaults to IN_STOCK → add", () => {
    expect(tileCta({}, 0)).toBe("add");
  });
});

describe("alertIdSet", () => {
  it("undefined alerts → empty set", () => {
    const set = alertIdSet(undefined);
    expect(set.size).toBe(0);
  });

  it("builds a set from productIds", () => {
    const alerts: BuyerStockAlerts = { productIds: ["a", "b", "b"] };
    const set = alertIdSet(alerts);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe("deriveTilePrice", () => {
  it("no promo rules → returns the base price unchanged, no strikethrough", () => {
    const product = { id: "x", buyerPrice: 25, category: "Snacks", unitsPerBox: null };
    const priced = deriveTilePrice(product, [], undefined);
    expect(priced.unitPrice).toBe(25);
    expect(priced.originalPrice).toBeNull();
  });

  it("falls back buyerPrice → basePrice → price when earlier fields are absent", () => {
    const base: { id: string; category?: string; unitsPerBox: null } = {
      id: "a",
      unitsPerBox: null,
    };
    expect(
      deriveTilePrice({ ...base, buyerPrice: 25, basePrice: 30, price: 35 }, [], undefined)
        .unitPrice,
    ).toBe(25);
    expect(deriveTilePrice({ ...base, basePrice: 30, price: 35 }, [], undefined).unitPrice).toBe(
      30,
    );
    expect(deriveTilePrice({ ...base, price: 35 }, [], undefined).unitPrice).toBe(35);
    expect(deriveTilePrice({ ...base }, [], undefined).unitPrice).toBe(0);
  });

  it("PERCENT promo produces a struck original + net box price", () => {
    const product = { id: "case", buyerPrice: 120, category: "Drinks", unitsPerBox: 12 };
    const rules: PromotionRule[] = [{ id: "p1", type: "PERCENT", value: 10, scope: "ALL" }];
    const priced = deriveTilePrice(product, rules, undefined);
    expect(priced.unitPrice).toBe(108);
    expect(priced.originalPrice).toBe(120);
  });

  it("QTY_BREAK: a boxed product's default add qty (no cart item) satisfies a minQty == unitsPerBox gate", () => {
    const product = { id: "case", buyerPrice: 120, category: "Drinks", unitsPerBox: 12 };
    const rules: PromotionRule[] = [
      { id: "p1", type: "QTY_BREAK", value: 25, minQty: 12, scope: "ALL" },
    ];
    const priced = deriveTilePrice(product, rules, undefined);
    expect(priced.unitPrice).toBe(90);
    expect(priced.originalPrice).toBe(120);
  });

  it("QTY_BREAK: a non-boxed product's default add qty (1 piece) does NOT satisfy a minQty > 1 gate", () => {
    const product = { id: "soda", buyerPrice: 10, category: "Drinks", unitsPerBox: null };
    const rules: PromotionRule[] = [
      { id: "p1", type: "QTY_BREAK", value: 25, minQty: 2, scope: "ALL" },
    ];
    const priced = deriveTilePrice(product, rules, undefined);
    expect(priced.unitPrice).toBe(10);
    expect(priced.originalPrice).toBeNull();
  });

  it("matches priceCart's net/original to the cent for the same boxed cart line (money anchor)", () => {
    const product = { id: "case", buyerPrice: 120, category: "Drinks", unitsPerBox: 12 };
    const cartItem: CartItem = {
      productId: "case",
      name: "Case",
      unitPrice: 120,
      qty: 24,
      category: "Drinks",
      unitsPerBox: 12,
      boxes: 2,
      pieces: 0,
    };
    const rules: PromotionRule[] = [
      { id: "p1", type: "QTY_BREAK", value: 25, minQty: 24, scope: "ALL" },
    ];

    const priced = deriveTilePrice(product, rules, cartItem);

    const cartLine: CartLineInput = {
      productId: "case",
      category: "Drinks",
      unitPrice: 120,
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
    };
    const cart = priceCart([cartLine], rules);

    expect(priced.unitPrice).toBe(cart.lines[0].net);
    expect(priced.originalPrice).toBe(cart.lines[0].original);
    expect(priced.unitPrice).toBe(90);
    expect(priced.originalPrice).toBe(120);
  });

  it("matches priceCart's net/original to the cent for a simple non-boxed cart line", () => {
    const product = { id: "soda", buyerPrice: 10, category: "Drinks", unitsPerBox: null };
    const cartItem: CartItem = {
      productId: "soda",
      name: "Soda",
      unitPrice: 10,
      qty: 3,
      category: "Drinks",
    };
    const rules: PromotionRule[] = [{ id: "p1", type: "PERCENT", value: 10, scope: "ALL" }];

    const priced = deriveTilePrice(product, rules, cartItem);

    const cartLine: CartLineInput = {
      productId: "soda",
      category: "Drinks",
      unitPrice: 10,
      qty: 3,
    };
    const cart = priceCart([cartLine], rules);

    expect(priced.unitPrice).toBe(cart.lines[0].net);
    expect(priced.originalPrice).toBe(cart.lines[0].original);
  });
});

describe("computeTileChip", () => {
  const noPromo: PromoResult = {
    unitPrice: 10,
    originalPrice: null,
    appliedPromoId: null,
    freeUnits: 0,
  };
  const promoted = (unitPrice: number, originalPrice: number): PromoResult => ({
    unitPrice,
    originalPrice,
    appliedPromoId: "p1",
    freeUnits: 0,
  });

  it("Deal (from a promo) takes priority over New and Featured, with a percent label", () => {
    const chip = computeTileChip(
      { isDeal: false, isNew: true, isFeatured: true },
      promoted(90, 120),
    );
    expect(chip).toEqual({ kind: "deal", label: "Deal -25%" });
  });

  it("a plain isDeal flag with no promo delta renders a bare Deal label", () => {
    const chip = computeTileChip({ isDeal: true, isNew: false, isFeatured: false }, noPromo);
    expect(chip).toEqual({ kind: "deal", label: "Deal" });
  });

  it("New beats Low and Featured when there is no deal", () => {
    const chip = computeTileChip(
      { isDeal: false, isNew: true, isFeatured: true },
      noPromo,
      estimate({ state: "low" }),
    );
    expect(chip).toEqual({ kind: "new", label: "New" });
  });

  it("Running low beats Featured when there is no deal or New", () => {
    const chip = computeTileChip(
      { isDeal: false, isNew: false, isFeatured: true },
      noPromo,
      estimate({ state: "low" }),
    );
    expect(chip).toEqual({ kind: "low", label: "Running low" });
  });

  it("Featured only when nothing else applies", () => {
    const chip = computeTileChip({ isDeal: false, isNew: false, isFeatured: true }, noPromo);
    expect(chip).toEqual({ kind: "featured", label: "Featured" });
  });

  it("null when no chip condition is met", () => {
    const chip = computeTileChip({ isDeal: false, isNew: false, isFeatured: false }, noPromo);
    expect(chip).toBeNull();
  });
});

describe("stockLabel", () => {
  it("out of stock → danger tone", () => {
    expect(stockLabel({ stockStatus: "OUT_OF_STOCK", stockLeft: null })).toEqual({
      label: "Out of stock",
      tone: "danger",
    });
  });

  it("low with a known stockLeft count → warn tone, count in the label", () => {
    expect(stockLabel({ stockStatus: "LOW", stockLeft: 4 })).toEqual({
      label: "Only 4 left",
      tone: "warn",
    });
  });

  it("low without a known stockLeft count → generic warn label", () => {
    expect(stockLabel({ stockStatus: "LOW", stockLeft: null })).toEqual({
      label: "Low stock",
      tone: "warn",
    });
  });

  it("in stock (or missing stockStatus) → ok tone", () => {
    expect(stockLabel({ stockStatus: "IN_STOCK", stockLeft: null })).toEqual({
      label: "In stock",
      tone: "ok",
    });
    expect(stockLabel({})).toEqual({ label: "In stock", tone: "ok" });
  });
});

describe("behaviorLabel", () => {
  it("no estimate → null", () => {
    expect(behaviorLabel(undefined)).toBeNull();
  });

  it("fewer than 2 orders → null", () => {
    expect(behaviorLabel(estimate({ orderCount: 1 }))).toBeNull();
  });

  it("cadence in the weekly bucket (5-9 days)", () => {
    expect(behaviorLabel(estimate({ orderCount: 4, cadenceDays: 7 }))).toBe("You order weekly");
  });

  it("cadence in the biweekly bucket (12-18 days)", () => {
    expect(behaviorLabel(estimate({ orderCount: 4, cadenceDays: 14 }))).toBe("You order biweekly");
  });

  it("cadence in the monthly bucket (25-35 days)", () => {
    expect(behaviorLabel(estimate({ orderCount: 4, cadenceDays: 30 }))).toBe("You order monthly");
  });

  it("cadence outside any named bucket falls back to a raw day count", () => {
    expect(behaviorLabel(estimate({ orderCount: 4, cadenceDays: 3 }))).toBe(
      "You order every ~3 days",
    );
  });

  it("no cadence, enough orders → Bought Nx", () => {
    expect(behaviorLabel(estimate({ orderCount: 5, cadenceDays: null }))).toBe("Bought 5x");
  });
});
