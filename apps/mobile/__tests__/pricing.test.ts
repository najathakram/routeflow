/**
 * Mobile pricing mirror must agree with the server (apps/api/src/common/pricing.ts)
 * so the operator sees exactly the number the API will store — including the
 * money-rounding fix (220 x 2 = 440, never 420 / 16.467…).
 */
import {
  computeLineSubtotal,
  roundMoney,
  normalizeBoxesPieces,
  applyBestPromotion,
  type PromotionRule,
} from "../lib/pricing";

describe("roundMoney (mobile mirror)", () => {
  it("rounds to cents", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(14.97 * 1.1)).toBe(16.47);
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
  const ctx = { productId: "p1", category: "Beverages", qtyPieces: 1 };

  it("PERCENT nets the price + records the strikethrough original", () => {
    const r = applyBestPromotion(100, [p({ id: "a", type: "PERCENT", value: 10 })], ctx);
    expect(r).toEqual({ unitPrice: 90, originalPrice: 100, appliedPromoId: "a" });
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
