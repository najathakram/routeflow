/**
 * Buyer-cart promotion pricing: the per-line best-promo evaluation + subtotal /
 * savings reconciliation the mobile cart shows. Must match what the server bills
 * (server re-prices on submit via the same applyBestPromotion).
 */
import { priceCart, promoRulesFrom, type CartLineInput } from "../lib/buyer-cart-pricing";
import type { BuyerPromotion } from "../lib/api/buyer";

function promo(p: Partial<BuyerPromotion>): BuyerPromotion {
  return {
    id: "p1",
    name: "Promo",
    bannerText: null,
    type: "PERCENT",
    value: 10,
    minQty: null,
    scope: "ALL",
    category: null,
    startsAt: "2026-01-01",
    endsAt: "2026-12-31",
    productIds: [],
    ...p,
  };
}

const soda: CartLineInput = { productId: "soda", category: "Drinks", unitPrice: 10, qty: 3 };

describe("priceCart", () => {
  it("no promotions → subtotal = sum, savings 0, no strikethrough", () => {
    const r = priceCart([soda], promoRulesFrom(undefined));
    expect(r.subtotal).toBe(30);
    expect(r.savings).toBe(0);
    expect(r.lines[0].original).toBeNull();
    expect(r.lines[0].net).toBe(10);
  });

  it("PERCENT ALL promo lowers net and reports savings", () => {
    const r = priceCart([soda], promoRulesFrom([promo({ type: "PERCENT", value: 10 })]));
    expect(r.lines[0].net).toBe(9); // 10% off
    expect(r.lines[0].original).toBe(10);
    expect(r.subtotal).toBe(27);
    expect(r.savings).toBe(3);
  });

  it("CATEGORY promo applies only to matching-category lines", () => {
    const snacks: CartLineInput = { productId: "chips", category: "Snacks", unitPrice: 5, qty: 2 };
    const rules = promoRulesFrom([
      promo({ scope: "CATEGORY", category: "Drinks", type: "PERCENT", value: 50 }),
    ]);
    const r = priceCart([soda, snacks], rules);
    expect(r.lines[0].net).toBe(5); // Drinks halved
    expect(r.lines[1].net).toBe(5); // Snacks untouched
    expect(r.savings).toBe(15); // only the soda line: (10-5)*3
  });

  it("QTY_BREAK gates on total PIECES (boxed line crosses the threshold)", () => {
    // 2 boxes × 12 = 24 pieces ≥ minQty 24 → break applies to the box price.
    const boxed: CartLineInput = {
      productId: "case",
      category: "Drinks",
      unitPrice: 120, // box price
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
    };
    const rules = promoRulesFrom([
      promo({ type: "QTY_BREAK", value: 25, minQty: 24, scope: "ALL" }),
    ]);
    const r = priceCart([boxed], rules);
    expect(r.lines[0].net).toBe(90); // 25% off the box price
    expect(r.lines[0].lineSubtotal).toBe(180); // 2 boxes × 90
    expect(r.savings).toBe(60);
  });

  it("QTY_BREAK below the piece threshold does NOT apply", () => {
    const one: CartLineInput = { productId: "soda", category: "Drinks", unitPrice: 10, qty: 5 };
    const rules = promoRulesFrom([promo({ type: "QTY_BREAK", value: 25, minQty: 24 })]);
    const r = priceCart([one], rules);
    expect(r.lines[0].original).toBeNull();
    expect(r.savings).toBe(0);
  });

  it("FIXED is $ off per selling unit and reconciles across the line", () => {
    const rules = promoRulesFrom([promo({ type: "FIXED", value: 2, scope: "ALL" })]);
    const r = priceCart([soda], rules); // $2 off each of 3 pieces
    expect(r.lines[0].net).toBe(8);
    expect(r.subtotal).toBe(24);
    expect(r.savings).toBe(6);
  });

  it("promoRulesFrom passes null minQty/category through unchanged", () => {
    const rules = promoRulesFrom([promo({ minQty: null, category: null })]);
    expect(rules[0].minQty).toBeNull();
    expect(rules[0].category).toBeNull();
  });
});
