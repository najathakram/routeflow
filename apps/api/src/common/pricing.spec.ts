import {
  computeLineSubtotal,
  roundMoney,
  normalizeBoxesPieces,
  perUnitPrice,
  costPerSellingUnit,
  computeMarginFraction,
  priceForMarginFloor,
  classifyMargin,
  computeCategoryTax,
  applyBestPromotion,
  promotionMatchesProduct,
  isUpsellLine,
  effectiveBuyerPrice,
  formatQtySplit,
  type PromotionRule,
} from "./pricing";

/**
 * Money-math regression suite. These lock the fixes for the reported
 * "totals sometimes wrong" bug (e.g. 220 x 2 shown as 420 instead of 440) and
 * the boxed-product proration so they can never silently regress.
 */
describe("pricing — money discipline", () => {
  describe("roundMoney", () => {
    it("rounds to cents and kills float drift", () => {
      expect(roundMoney(0.1 + 0.2)).toBe(0.3); // 0.30000000000000004 → 0.3
      expect(roundMoney(440)).toBe(440);
      expect(roundMoney(4.005)).toBe(4.01); // half-up at the cent
      expect(roundMoney(2.675)).toBe(2.68);
    });

    it("handles negatives and non-finite input", () => {
      expect(roundMoney(-1.005)).toBe(-1.01);
      expect(roundMoney(NaN)).toBe(0);
      expect(roundMoney(Infinity)).toBe(0);
    });
  });

  describe("computeLineSubtotal — the reported bug", () => {
    it("220 x 2 units is exactly 440 (non-boxed)", () => {
      expect(computeLineSubtotal({ unitPrice: 220, qty: 2 })).toBe(440);
    });

    it("a box-priced product bills per BOX, not per piece", () => {
      // unitPrice is the BOX price; 2 full boxes of an 11-pack = 2 x 220 = 440,
      // NOT qty(22 pieces) x 220 = 4840.
      expect(
        computeLineSubtotal({ unitPrice: 220, qty: 22, boxes: 2, pieces: 0, unitsPerBox: 11 }),
      ).toBe(440);
      expect(
        computeLineSubtotal({ unitPrice: 220, qty: 11, boxes: 1, pieces: 0, unitsPerBox: 11 }),
      ).toBe(220);
    });

    it("prorates loose pieces below a full box", () => {
      // 1 box + 10 loose pieces of an 11-pack = 1 + 10/11 boxes = 220 x 21/11 = 420.
      // This is CORRECT proration — 420 only appears when the entry genuinely is
      // 21 pieces, never for "2 boxes" (which must be 440).
      expect(
        computeLineSubtotal({ unitPrice: 220, qty: 21, boxes: 1, pieces: 10, unitsPerBox: 11 }),
      ).toBe(420);
    });

    it("rounds fractional proration to cents", () => {
      // 220 / 3 = 73.333... → 73.33
      expect(
        computeLineSubtotal({ unitPrice: 220, qty: 1, boxes: 0, pieces: 1, unitsPerBox: 3 }),
      ).toBe(73.33);
    });

    it("treats unitsPerBox <= 1 as per-piece", () => {
      expect(computeLineSubtotal({ unitPrice: 5.25, qty: 4, unitsPerBox: 1 })).toBe(21);
      expect(computeLineSubtotal({ unitPrice: 5.25, qty: 4, unitsPerBox: null })).toBe(21);
    });
  });

  describe("perUnitPrice — display-only case-price / units-per-case hint", () => {
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

  describe("normalizeBoxesPieces — integer hygiene + rollover", () => {
    it("rolls loose pieces that reach a full box up into boxes", () => {
      expect(normalizeBoxesPieces({ boxes: 1, pieces: 11, unitsPerBox: 11 })).toEqual({
        boxes: 2,
        pieces: 0,
        qty: 22,
      });
      expect(normalizeBoxesPieces({ boxes: 0, pieces: 23, unitsPerBox: 11 })).toEqual({
        boxes: 2,
        pieces: 1,
        qty: 23,
      });
    });

    it("keeps loose pieces below a full box as-is", () => {
      expect(normalizeBoxesPieces({ boxes: 1, pieces: 10, unitsPerBox: 11 })).toEqual({
        boxes: 1,
        pieces: 10,
        qty: 21,
      });
    });

    it("derives a boxes/pieces split from a raw piece qty", () => {
      expect(normalizeBoxesPieces({ qty: 22, unitsPerBox: 11 })).toEqual({
        boxes: 2,
        pieces: 0,
        qty: 22,
      });
    });

    it("forces integers — no decimals, no leading-zero artifacts", () => {
      expect(normalizeBoxesPieces({ qty: 2.7, unitsPerBox: 1 })).toEqual({
        boxes: null,
        pieces: null,
        qty: 2,
      });
      expect(normalizeBoxesPieces({ boxes: 1.9, pieces: 2.9, unitsPerBox: 11 })).toEqual({
        boxes: 1,
        pieces: 2,
        qty: 13,
      });
    });

    it("clamps negatives to zero", () => {
      expect(normalizeBoxesPieces({ qty: -5, unitsPerBox: 1 })).toEqual({
        boxes: null,
        pieces: null,
        qty: 0,
      });
    });
  });

  describe("invoice-from-order parity (buildInvoiceItemData logic)", () => {
    // Reproduces the per-line math buildInvoiceItemData runs so the boxed
    // overcharge (qty-in-pieces x box-price) can never come back.
    const billLine = (unitPrice: number, billedPieces: number, unitsPerBox: number) => {
      const split = normalizeBoxesPieces({ qty: billedPieces, unitsPerBox });
      return computeLineSubtotal({
        unitPrice,
        qty: split.qty,
        boxes: split.boxes,
        pieces: split.pieces,
        unitsPerBox,
      });
    };

    it("invoice line matches the order line for boxed products", () => {
      expect(billLine(220, 22, 11)).toBe(440); // full order: 2 boxes
      expect(billLine(220, 11, 11)).toBe(220); // partial: 1 box remaining
      expect(billLine(220, 5, 11)).toBe(100); // partial loose: 5/11 x 220
    });

    it("non-boxed invoice line is qty x unitPrice", () => {
      expect(billLine(220, 2, 0)).toBe(440);
      expect(billLine(3.5, 4, 1)).toBe(14);
    });
  });

  // ─── Margin (negotiation floor) ─────────────────────────────────────────────
  describe("margin helpers", () => {
    it("costPerSellingUnit scales piece cost to the box for boxed products", () => {
      expect(costPerSellingUnit(0.58, 24)).toBeCloseTo(13.92, 5); // 24-pack @ $0.58/pc
      expect(costPerSellingUnit(0.58, 1)).toBe(0.58); // non-boxed = piece cost
      expect(costPerSellingUnit(0.58, null)).toBe(0.58);
    });

    it("computeMarginFraction uses box-basis cost vs box price", () => {
      // Design example: box price $21.60, piece cost $0.58, 24/case → cost $13.92, 35.6%
      const m = computeMarginFraction(21.6, 0.58, 24);
      expect(m).not.toBeNull();
      expect((m as number) * 100).toBeCloseTo(35.6, 1);
    });

    it("computeMarginFraction is negative below cost and null without cost/price", () => {
      expect(computeMarginFraction(10, 8, 1)! * 100).toBeCloseTo(20, 5);
      expect(computeMarginFraction(5, 8, 1)).toBeLessThan(0); // below cost
      expect(computeMarginFraction(10, null, 1)).toBeNull();
      expect(computeMarginFraction(0, 8, 1)).toBeNull();
    });

    it("priceForMarginFloor yields exactly the floor margin (round-trip)", () => {
      const price = priceForMarginFloor(0.58, 0.2, 24); // 20% floor on a 24-pack
      const m = computeMarginFraction(price, 0.58, 24)!;
      expect(m).toBeCloseTo(0.2, 4);
      // non-boxed: cost 8, 25% floor → 8 / 0.75 = 10.67
      expect(priceForMarginFloor(8, 0.25, 1)).toBe(10.67);
    });

    it("classifyMargin buckets below-cost / below-floor / warn / ok", () => {
      const floor = 0.15;
      expect(classifyMargin(-0.05, floor)).toBe("belowCost");
      expect(classifyMargin(0.1, floor)).toBe("belowFloor");
      expect(classifyMargin(0.17, floor)).toBe("warn"); // within 5 pts above floor
      expect(classifyMargin(0.3, floor)).toBe("ok");
      expect(classifyMargin(null, floor)).toBeNull();
    });
  });
});

describe("computeCategoryTax — regulated items (W3)", () => {
  it("returns 0 for NONE or a non-positive rate", () => {
    expect(
      computeCategoryTax({ taxType: "NONE", rate: 5, unitBasisQty: 10, lineSubtotal: 100 }),
    ).toBe(0);
    expect(
      computeCategoryTax({
        taxType: "EXCISE_PER_UNIT",
        rate: 0,
        unitBasisQty: 10,
        lineSubtotal: 100,
      }),
    ).toBe(0);
    expect(
      computeCategoryTax({
        taxType: "EXCISE_PER_UNIT",
        rate: -1,
        unitBasisQty: 10,
        lineSubtotal: 100,
      }),
    ).toBe(0);
  });

  it("EXCISE_PER_UNIT applies the rate per PIECE (e.g. $2.87/pack × 10 packs)", () => {
    expect(
      computeCategoryTax({
        taxType: "EXCISE_PER_UNIT",
        rate: 2.87,
        unitBasisQty: 10,
        lineSubtotal: 80,
      }),
    ).toBe(28.7);
  });

  it("DEPOSIT_PER_CONTAINER levies per container (caller passes the piece count)", () => {
    expect(
      computeCategoryTax({
        taxType: "DEPOSIT_PER_CONTAINER",
        rate: 0.05,
        unitBasisQty: 24,
        lineSubtotal: 0,
      }),
    ).toBe(1.2);
  });

  it("PER_VOLUME levies on the TRUE volume the caller passes, not the piece count", () => {
    // $0.01/oz on twenty 16oz bottles → caller passes unitBasisQty = 20 × 16 = 320 oz.
    // Correct: 0.01 × 320 = $3.20 (the pre-fix "1 piece = 1 oz" bug returned 0.01 × 20 = $0.20).
    expect(
      computeCategoryTax({ taxType: "PER_VOLUME", rate: 0.01, unitBasisQty: 320, lineSubtotal: 0 }),
    ).toBe(3.2);
    expect(
      computeCategoryTax({ taxType: "PER_VOLUME", rate: 0.01, unitBasisQty: 320, lineSubtotal: 0 }),
    ).not.toBe(0.2);
  });

  it("PERCENT_OF_SALE (added) is rate × subtotal", () => {
    // 5% of $80 = $4.00. rate is a fraction.
    expect(
      computeCategoryTax({
        taxType: "PERCENT_OF_SALE",
        rate: 0.05,
        unitBasisQty: 10,
        lineSubtotal: 80,
      }),
    ).toBe(4);
  });

  it("PERCENT_OF_SALE (priceIncludesTax) backs the tax out of the tax-inclusive subtotal", () => {
    // $105 already includes 5% → embedded tax = 105 × 0.05/1.05 = $5.00.
    expect(
      computeCategoryTax({
        taxType: "PERCENT_OF_SALE",
        rate: 0.05,
        priceIncludesTax: true,
        unitBasisQty: 10,
        lineSubtotal: 105,
      }),
    ).toBe(5);
  });

  it("CRITICAL: a boxed line's excise uses the PIECE count, never boxes or the boxed subtotal", () => {
    // Boxed product: unitsPerBox=10, box price $50, sell 2 boxes = 20 pieces.
    const norm = normalizeBoxesPieces({ boxes: 2, pieces: 0, unitsPerBox: 10 });
    expect(norm.qty).toBe(20);
    const subtotal = computeLineSubtotal({
      unitPrice: 50,
      qty: norm.qty,
      boxes: norm.boxes,
      pieces: norm.pieces,
      unitsPerBox: 10,
    });
    expect(subtotal).toBe(100); // 2 boxes × $50 (box-priced, NOT 20 × $50)

    const tax = computeCategoryTax({
      taxType: "EXCISE_PER_UNIT",
      rate: 2.87,
      unitBasisQty: norm.qty,
      lineSubtotal: subtotal,
    });
    // Correct: $2.87 × 20 packs = $57.40.
    expect(tax).toBe(57.4);
    // Guard against the two classic bugs:
    expect(tax).not.toBe(5.74); // 2 boxes × $2.87 (per-BOX, wrong)
    expect(tax).not.toBe(287); // 20 × $50 × ... nonsense off the subtotal
  });

  it("composes with a box+pieces split (2 boxes + 3 loose of 10 = 23 pieces)", () => {
    const norm = normalizeBoxesPieces({ boxes: 2, pieces: 3, unitsPerBox: 10 });
    expect(norm.qty).toBe(23);
    expect(
      computeCategoryTax({
        taxType: "EXCISE_PER_UNIT",
        rate: 1,
        unitBasisQty: norm.qty,
        lineSubtotal: 0,
      }),
    ).toBe(23);
  });

  it("accepts a fractional unitBasisQty (volume) and rounds the levy to cents", () => {
    // $0.005/oz × 12.5 oz = $0.0625 → $0.06
    expect(
      computeCategoryTax({
        taxType: "PER_VOLUME",
        rate: 0.005,
        unitBasisQty: 12.5,
        lineSubtotal: 0,
      }),
    ).toBe(0.06);
    // $0.333 × 3 = 0.999 → $1.00
    expect(
      computeCategoryTax({
        taxType: "EXCISE_PER_UNIT",
        rate: 0.333,
        unitBasisQty: 3,
        lineSubtotal: 0,
      }),
    ).toBe(1);
  });

  it("preserves sign so a return/reversal line reverses the tax", () => {
    expect(
      computeCategoryTax({
        taxType: "EXCISE_PER_UNIT",
        rate: 2.87,
        unitBasisQty: -10,
        lineSubtotal: -80,
      }),
    ).toBe(-28.7);
    expect(
      computeCategoryTax({
        taxType: "PERCENT_OF_SALE",
        rate: 0.05,
        unitBasisQty: 0,
        lineSubtotal: -80,
      }),
    ).toBe(-4);
  });

  it("guards non-finite quantities and subtotals", () => {
    expect(
      computeCategoryTax({
        taxType: "EXCISE_PER_UNIT",
        rate: 2,
        unitBasisQty: Number.NaN,
        lineSubtotal: 0,
      }),
    ).toBe(0);
    expect(
      computeCategoryTax({
        taxType: "PERCENT_OF_SALE",
        rate: 0.05,
        unitBasisQty: 0,
        lineSubtotal: Number.NaN,
      }),
    ).toBe(0);
  });
});

// ─── Promotions (P5-04) ───────────────────────────────────────────────────────

const promo = (
  over: Partial<PromotionRule> & Pick<PromotionRule, "id" | "type">,
): PromotionRule => ({
  value: 0,
  scope: "ALL",
  minQty: null,
  category: null,
  productIds: null,
  ...over,
});

describe("promotionMatchesProduct — scope matching", () => {
  const ctx = { productId: "p1", category: "Beverages", qtyPieces: 1 };
  it("ALL matches every product", () => {
    expect(promotionMatchesProduct(promo({ id: "a", type: "PERCENT", scope: "ALL" }), ctx)).toBe(
      true,
    );
  });
  it("CATEGORY matches only the exact category string", () => {
    expect(
      promotionMatchesProduct(
        promo({ id: "a", type: "PERCENT", scope: "CATEGORY", category: "Beverages" }),
        ctx,
      ),
    ).toBe(true);
    expect(
      promotionMatchesProduct(
        promo({ id: "a", type: "PERCENT", scope: "CATEGORY", category: "Snacks" }),
        ctx,
      ),
    ).toBe(false);
    // Empty/mismatched category never matches (no silent ALL fallthrough).
    expect(
      promotionMatchesProduct(
        promo({ id: "a", type: "PERCENT", scope: "CATEGORY", category: null }),
        ctx,
      ),
    ).toBe(false);
  });
  it("PRODUCTS matches only ids in the set", () => {
    expect(
      promotionMatchesProduct(
        promo({ id: "a", type: "PERCENT", scope: "PRODUCTS", productIds: ["p1", "p2"] }),
        ctx,
      ),
    ).toBe(true);
    expect(
      promotionMatchesProduct(
        promo({ id: "a", type: "PERCENT", scope: "PRODUCTS", productIds: ["p9"] }),
        ctx,
      ),
    ).toBe(false);
  });
});

describe("applyBestPromotion", () => {
  const ctx = (
    over: Partial<{ productId: string; category: string | null; qtyPieces: number }> = {},
  ) => ({
    productId: "p1",
    category: "Beverages",
    qtyPieces: 1,
    ...over,
  });

  it("PERCENT lowers the price and records the pre-promo original", () => {
    const r = applyBestPromotion(100, [promo({ id: "a", type: "PERCENT", value: 10 })], ctx());
    expect(r.unitPrice).toBe(90);
    expect(r.originalPrice).toBe(100);
    expect(r.appliedPromoId).toBe("a");
  });

  it("FIXED subtracts $ off the SELLING-UNIT (box) price, floored at 0", () => {
    // $5 off a $43.75 box → $38.75 (never $5 × unitsPerBox).
    const r = applyBestPromotion(43.75, [promo({ id: "a", type: "FIXED", value: 5 })], ctx());
    expect(r.unitPrice).toBe(38.75);
    expect(r.originalPrice).toBe(43.75);
    // Floors at 0 — a fixed amount bigger than the price can't go negative.
    const r2 = applyBestPromotion(8, [promo({ id: "b", type: "FIXED", value: 10 })], ctx());
    expect(r2.unitPrice).toBe(0);
  });

  it("QTY_BREAK applies ONLY at/above the minQty piece threshold", () => {
    const p = promo({ id: "a", type: "QTY_BREAK", value: 15, minQty: 12 });
    // Below threshold → no promo, base unchanged, no strikethrough.
    const below = applyBestPromotion(100, [p], ctx({ qtyPieces: 11 }));
    expect(below.unitPrice).toBe(100);
    expect(below.originalPrice).toBeNull();
    expect(below.appliedPromoId).toBeNull();
    // At threshold → 15% off.
    const at = applyBestPromotion(100, [p], ctx({ qtyPieces: 12 }));
    expect(at.unitPrice).toBe(85);
    expect(at.appliedPromoId).toBe("a");
  });

  it("picks the promo that yields the lowest net price (best for the buyer)", () => {
    const promos = [
      promo({ id: "a", type: "PERCENT", value: 10 }), // → 90
      promo({ id: "b", type: "FIXED", value: 25 }), // → 75
      promo({ id: "c", type: "PERCENT", value: 5 }), // → 95
    ];
    const r = applyBestPromotion(100, promos, ctx());
    expect(r.unitPrice).toBe(75);
    expect(r.appliedPromoId).toBe("b");
  });

  it("breaks ties deterministically by promo id", () => {
    const promos = [
      promo({ id: "zzz", type: "PERCENT", value: 10 }),
      promo({ id: "aaa", type: "PERCENT", value: 10 }),
    ];
    expect(applyBestPromotion(100, promos, ctx()).appliedPromoId).toBe("aaa");
  });

  it("returns the base unchanged when nothing applies (no promos, wrong scope, non-lowering)", () => {
    expect(applyBestPromotion(50, [], ctx())).toEqual({
      unitPrice: 50,
      originalPrice: null,
      appliedPromoId: null,
    });
    // Scope mismatch.
    const scoped = applyBestPromotion(
      50,
      [promo({ id: "a", type: "PERCENT", value: 10, scope: "PRODUCTS", productIds: ["other"] })],
      ctx(),
    );
    expect(scoped.appliedPromoId).toBeNull();
    // A 0% / non-positive promo never applies.
    expect(applyBestPromotion(50, [promo({ id: "z", type: "PERCENT", value: 0 })], ctx())).toEqual({
      unitPrice: 50,
      originalPrice: null,
      appliedPromoId: null,
    });
  });

  it("CRITICAL: a boxed promo line prorates through computeLineSubtotal, never per-piece", () => {
    // Boxed product: unitsPerBox=6, box price $43.75, sell 2 boxes + 0 pieces = 12 pieces.
    const norm = normalizeBoxesPieces({ boxes: 2, pieces: 0, unitsPerBox: 6 });
    expect(norm.qty).toBe(12);
    // 20% off the BOX price → net box price $35.00.
    const r = applyBestPromotion(43.75, [promo({ id: "a", type: "PERCENT", value: 20 })], {
      productId: "p1",
      category: "Beverages",
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
    expect(subtotal).toBe(70); // 2 boxes × $35.00
    // Guard the classic over-charge: net-per-piece × 12 pieces.
    expect(subtotal).not.toBe(420); // $35 × 12
  });
});

describe("pricing — upsell direction & sticky effective price", () => {
  describe("isUpsellLine", () => {
    it("true only for a MANUAL line priced ABOVE its catalog base", () => {
      expect(isUpsellLine({ priceType: "MANUAL", unitPrice: 12, originalPrice: 10 })).toBe(true);
    });

    it("false for a MANUAL discount (net below base)", () => {
      expect(isUpsellLine({ priceType: "MANUAL", unitPrice: 8, originalPrice: 10 })).toBe(false);
    });

    it("false for non-MANUAL types even when net > original (e.g. a premium SPECIAL tier)", () => {
      expect(isUpsellLine({ priceType: "SPECIAL", unitPrice: 12, originalPrice: 10 })).toBe(false);
      expect(isUpsellLine({ priceType: "PROMO", unitPrice: 12, originalPrice: 10 })).toBe(false);
    });

    it("false when originalPrice is null or equal to unitPrice", () => {
      expect(isUpsellLine({ priceType: "MANUAL", unitPrice: 12, originalPrice: null })).toBe(false);
      expect(isUpsellLine({ priceType: "MANUAL", unitPrice: 10, originalPrice: 10 })).toBe(false);
    });

    it("coerces Decimal-like string fields", () => {
      expect(
        isUpsellLine({ priceType: "MANUAL", unitPrice: "12.50", originalPrice: "10.00" }),
      ).toBe(true);
    });
  });

  describe("effectiveBuyerPrice", () => {
    it("a remembered UPSELL (above list) sticks and overrides the tier", () => {
      // tier 8, list 10, remembered upsell 12 → charge 12
      expect(effectiveBuyerPrice(8, 10, 12)).toBe(12);
    });

    it("a remembered price at/below LIST never sticks (keeps tier) — a discount can't RAISE a low tier", () => {
      // tier 8, list 10, remembered 9 (a discount off list, but above tier) → keep tier 8
      expect(effectiveBuyerPrice(8, 10, 9)).toBe(8);
      // remembered exactly at list → keep tier
      expect(effectiveBuyerPrice(8, 10, 10)).toBe(8);
    });

    it("returns the tier price when there is no remembered price", () => {
      expect(effectiveBuyerPrice(8, 10, null)).toBe(8);
      expect(effectiveBuyerPrice(8, 10, undefined)).toBe(8);
    });
  });
});

describe("formatQtySplit", () => {
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
