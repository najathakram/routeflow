/**
 * Mobile pricing mirror must agree with the server (apps/api/src/common/pricing.ts)
 * so the operator sees exactly the number the API will store — including the
 * money-rounding fix (220 x 2 = 440, never 420 / 16.467…).
 */
import {
  computeLineSubtotal,
  getTierPrice,
  cascadeTierPrices,
  perUnitPrice,
  roundMoney,
  normalizeBoxesPieces,
  applyBestPromotion,
  scanPromotionZeroPrice,
  ruleCanZeroPrice,
  formatQtySplit,
  type PromotionRule,
} from "../lib/pricing";

describe("roundMoney (mobile mirror)", () => {
  it("rounds to cents", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(14.97 * 1.1)).toBe(16.47);
  });
});

describe("getTierPrice (mobile mirror — must match apps/api/src/utils/pricing.ts)", () => {
  const product = {
    pricePerUnit: "10.00",
    priceTier2: "9.00",
    priceTier3: "8.50",
    priceTier4: "0", // DB default — tier never configured
    priceTier5: null as string | null,
  };

  it("returns the configured tier price; tier 1 = list", () => {
    expect(getTierPrice(product, 2)).toBe(9);
    expect(getTierPrice(product, 3)).toBe(8.5);
    expect(getTierPrice(product, 1)).toBe(10);
  });

  it("an unset tier (DB default 0) inherits the list price — the $0.00 regression", () => {
    expect(getTierPrice(product, 4)).toBe(10);
    expect(getTierPrice(product, 5)).toBe(10);
  });

  it("out-of-range tiers fall back to list", () => {
    expect(getTierPrice(product, 0)).toBe(10);
    expect(getTierPrice(product, 6)).toBe(10);
  });

  it("coerces numbers and strings; genuinely free products stay 0", () => {
    expect(getTierPrice({ pricePerUnit: 12.5, priceTier2: 11.25 }, 2)).toBe(11.25);
    expect(getTierPrice({ pricePerUnit: "0", priceTier2: "0" }, 2)).toBe(0);
  });
});

describe("cascadeTierPrices (mobile mirror — must match apps/api/src/utils/pricing.ts)", () => {
  it("copies the committed price down to every lower tier", () => {
    expect(cascadeTierPrices("priceTier2", 9)).toEqual({
      priceTier3: "9.00",
      priceTier4: "9.00",
      priceTier5: "9.00",
    });
  });

  it("cascades only to the tiers below the edited one", () => {
    expect(cascadeTierPrices("priceTier4", 8.5)).toEqual({ priceTier5: "8.50" });
  });

  it("tier 5 has nothing below it", () => {
    expect(cascadeTierPrices("priceTier5", 7)).toEqual({});
  });

  it("Tier 1 / pricePerUnit is deliberately excluded from the cascade", () => {
    expect(cascadeTierPrices("pricePerUnit", 10)).toEqual({});
  });

  it("rejects non-finite or negative input", () => {
    expect(cascadeTierPrices("priceTier2", NaN)).toEqual({});
    expect(cascadeTierPrices("priceTier2", -1)).toEqual({});
  });

  it("rounds half-up at the cent", () => {
    expect(cascadeTierPrices("priceTier2", 9.005)).toEqual({
      priceTier3: "9.01",
      priceTier4: "9.01",
      priceTier5: "9.01",
    });
  });

  it("committing 0 cascades an explicit 0.00 — the tiers inherit list price again under getTierPrice's fallback", () => {
    expect(cascadeTierPrices("priceTier3", 0)).toEqual({
      priceTier4: "0.00",
      priceTier5: "0.00",
    });
  });
});

describe("computeLineSubtotal (mobile mirror)", () => {
  it("220 x 2 = 440", () => {
    expect(computeLineSubtotal({ unitPrice: 220, qty: 2 })).toBe(440);
  });

  it("bills boxed products per box", () => {
    expect(
      computeLineSubtotal({ unitPrice: 220, qty: 22, boxes: 2, pieces: 0, unitsPerBox: 11 }),
    ).toBe(440);
  });

  it("prorates loose pieces", () => {
    expect(
      computeLineSubtotal({ unitPrice: 220, qty: 21, boxes: 1, pieces: 10, unitsPerBox: 11 }),
    ).toBe(420);
  });
});

describe("perUnitPrice (mobile mirror — display-only case-price / units-per-case hint)", () => {
  it("divides the case price by units-per-case, rounded to cents", () => {
    expect(perUnitPrice(10, 6)).toBe(1.67);
    expect(perUnitPrice(10, 3)).toBe(3.33);
  });

  it("returns null when the product is sold as single units", () => {
    expect(perUnitPrice(10, null)).toBeNull();
    expect(perUnitPrice(10, 0)).toBeNull();
    expect(perUnitPrice(10, 1)).toBeNull();
  });

  it("is display-only: the line subtotal, not perUnitPrice x pieces, is authoritative", () => {
    // 2 loose pieces of a 3-pack at a $10 case price: the line prorates BEFORE rounding.
    expect(
      computeLineSubtotal({ unitPrice: 10, qty: 2, boxes: 0, pieces: 2, unitsPerBox: 3 }),
    ).toBe(6.67);
    // The per-unit hint rounds first, so multiplying it back is a cent off — by design.
    expect(roundMoney(perUnitPrice(10, 3)! * 2)).toBe(6.66);
  });
});

describe("normalizeBoxesPieces (mobile mirror)", () => {
  it("rolls full boxes and forces integers", () => {
    expect(normalizeBoxesPieces({ boxes: 1, pieces: 11, unitsPerBox: 11 })).toEqual({
      boxes: 2,
      pieces: 0,
      qty: 22,
    });
    expect(normalizeBoxesPieces({ qty: 2.7, unitsPerBox: 1 })).toEqual({
      boxes: null,
      pieces: null,
      qty: 2,
    });
  });
});

describe("applyBestPromotion (mobile mirror — must match the server to the cent)", () => {
  const p = (o: Partial<PromotionRule> & Pick<PromotionRule, "id" | "type">): PromotionRule => ({
    value: 0,
    scope: "ALL",
    minQty: null,
    category: null,
    productIds: null,
    ...o,
  });
  const ctx = { productId: "p1", category: "Beverages", qtyPieces: 1, qtyUnits: 1 };

  it("PERCENT nets the price + records the strikethrough original", () => {
    const r = applyBestPromotion(100, [p({ id: "a", type: "PERCENT", value: 10 })], ctx);
    // Price promos carry freeUnits: 0 — only BUY_N_GET_M ever gives units away.
    expect(r).toEqual({ unitPrice: 90, originalPrice: 100, appliedPromoId: "a", freeUnits: 0 });
  });

  it("QTY_BREAK gates on the piece threshold", () => {
    const pr = p({ id: "a", type: "QTY_BREAK", value: 15, minQty: 12 });
    expect(applyBestPromotion(100, [pr], { ...ctx, qtyPieces: 11 }).appliedPromoId).toBeNull();
    expect(applyBestPromotion(100, [pr], { ...ctx, qtyPieces: 12 }).unitPrice).toBe(85);
  });

  it("boxed promo prorates via computeLineSubtotal (never per-piece)", () => {
    const norm = normalizeBoxesPieces({ boxes: 2, pieces: 0, unitsPerBox: 6 });
    const r = applyBestPromotion(43.75, [p({ id: "a", type: "PERCENT", value: 20 })], {
      ...ctx,
      qtyPieces: norm.qty,
    });
    expect(r.unitPrice).toBe(35);
    const subtotal = computeLineSubtotal({
      unitPrice: r.unitPrice,
      qty: norm.qty,
      boxes: norm.boxes,
      pieces: norm.pieces,
      unitsPerBox: 6,
    });
    expect(subtotal).toBe(70);
    expect(subtotal).not.toBe(420);
  });
});

describe("promotion zero-price scan (mobile mirror — must match the server exactly)", () => {
  const p = (o: Partial<PromotionRule> & Pick<PromotionRule, "id" | "type">): PromotionRule => ({
    value: 0,
    scope: "ALL",
    minQty: null,
    category: null,
    productIds: null,
    ...o,
  });
  const catalog = [
    { id: "p1", name: "Lighter 5-pack", category: "Novelty", price: 4.5 },
    { id: "p2", name: "Soda 24-case", category: "Beverages", price: 35 },
    { id: "p3", name: "Cigar box", category: "Tobacco", price: 120 },
  ];

  it("counts the in-scope products a FIXED amount would sell for $0.00", () => {
    const impact = scanPromotionZeroPrice(catalog, p({ id: "a", type: "FIXED", value: 35 }));
    expect(impact).toMatchObject({
      count: 2,
      inScope: 3,
      examples: ["Lighter 5-pack", "Soda 24-case"],
    });
  });

  it("skips the scan for an ordinary percentage rule", () => {
    expect(ruleCanZeroPrice({ type: "PERCENT", value: 40 })).toBe(false);
    expect(ruleCanZeroPrice({ type: "FIXED", value: 35 })).toBe(true);
  });
});

describe("formatQtySplit (mobile mirror)", () => {
  it("renders the stored split", () => {
    expect(formatQtySplit({ qty: 13, boxes: 2, pieces: 3 })).toBe("2 boxes + 3 pcs");
    expect(formatQtySplit({ qty: 5, boxes: 1, pieces: 0 })).toBe("1 box");
    expect(formatQtySplit({ qty: 4, boxes: 0, pieces: 4 })).toBe("4 pcs");
    expect(formatQtySplit({ qty: 0, boxes: 0, pieces: 0 })).toBe("0");
  });

  it("supports a custom loose-piece label", () => {
    expect(formatQtySplit({ qty: 4, boxes: 0, pieces: 4, unitLabel: "cans" })).toBe("4 cans");
  });

  it("renders plain qty for non-boxed lines (no split stored)", () => {
    expect(formatQtySplit({ qty: 5 })).toBe("5");
    expect(formatQtySplit({ qty: 2.5 })).toBe("2.5");
    expect(formatQtySplit({ qty: "3.000" })).toBe("3");
    expect(formatQtySplit({ qty: 1.2345 })).toBe("1.234"); // Decimal(10,3) storage
  });

  it("coerces junk defensively", () => {
    expect(formatQtySplit({ qty: 7, boxes: 2.9, pieces: -1 })).toBe("2 boxes");
    expect(formatQtySplit({ qty: "abc" })).toBe("abc");
  });
});
