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
  ruleCanZeroPrice,
  promotionZeroesProduct,
  scanPromotionZeroPrice,
  zeroPriceWarning,
  ZERO_PRICE_EXAMPLE_LIMIT,
  isUpsellLine,
  effectiveBuyerPrice,
  formatQtySplit,
  type PromotionRule,
  type PromoScopeProduct,
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

    // REG-B122: `Number.EPSILON` (~2.22e-16) is far below one half-ULP of any
    // double >= 2, so the "+ EPSILON" nudge is a no-op there and values whose
    // 3rd decimal digit is exactly 5 round DOWN instead of half-away-from-zero.
    // Every pin below is hand-worked base-10 arithmetic (the 3rd-decimal digit
    // is 5, so the cent above is always correct), independent of whatever an
    // IEEE-754 double happens to store for the literal.
    it("REG-B122: rounds 2.135 up to 2.14 (half-away-from-zero, not the current round-down)", () => {
      expect(roundMoney(2.135)).toBe(2.14);
    });

    it("REG-B122: rounds 2.175 up to 2.18", () => {
      expect(roundMoney(2.175)).toBe(2.18);
    });

    it("REG-B122: rounds 2.385 up to 2.39", () => {
      expect(roundMoney(2.385)).toBe(2.39);
    });

    it("REG-B122: rounds 2.425 up to 2.43", () => {
      expect(roundMoney(2.425)).toBe(2.43);
    });

    it("REG-B122: rounds 4.015 up to 4.02", () => {
      expect(roundMoney(4.015)).toBe(4.02);
    });

    it("REG-B122: rounds -2.135 to -2.14 (sign preserved, magnitude half-away-from-zero)", () => {
      expect(roundMoney(-2.135)).toBe(-2.14);
    });

    it("REG-B122: end-to-end — 7.5% of $29.00 is $2.18, not $2.17", () => {
      // 0.075 * 29.00 = 2.175 -> half-away-from-zero rounds to 2.18.
      expect(roundMoney(0.075 * 29.0)).toBe(2.18);
    });

    it("REG-B122: end-to-end — 7.5% of $27.40 is $2.06", () => {
      // 0.075 * 27.40 = 2.055 -> 2.06.
      expect(roundMoney(0.075 * 27.4)).toBe(2.06);
    });

    it("REG-B122: end-to-end — 15% off $9.50 nets $8.08", () => {
      // 9.50 * (1 - 0.15) = 9.50 * 0.85 = 8.075 -> 8.08.
      expect(roundMoney(9.5 * (1 - 15 / 100))).toBe(8.08);
    });

    it("REG-B122: deterministic half-cent sweep, $0.005 to $999.995 in cent steps — zero round-downs", () => {
      // Every half-cent value from $0.005 to $999.995 (100,000 of them). Each
      // is built from integer cents via string interpolation — the same
      // precision guarantee as typing a literal like `2.135` in source — so
      // this never leans on the implementation to construct its own inputs.
      // Half-away-from-zero means every one of these rounds UP to the next
      // cent; the sweep asserts there are zero exceptions.
      const failures: string[] = [];
      for (let c = 0; c < 100000; c++) {
        const dollars = Math.floor(c / 100);
        const cents = c % 100;
        const n = Number(`${dollars}.${String(cents).padStart(2, "0")}5`);
        let upDollars = dollars;
        let upCents = cents + 1;
        if (upCents === 100) {
          upCents = 0;
          upDollars += 1;
        }
        const expected = Number(`${upDollars}.${String(upCents).padStart(2, "0")}`);
        const actual = roundMoney(n);
        if (actual !== expected) {
          failures.push(`roundMoney(${n}) = ${actual}, expected ${expected} (half-away-from-zero)`);
        }
      }
      expect(failures).toEqual([]);
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

    it("REG-B122: perUnitPrice(4.27, 2) rounds the half-cent case up to $2.14, not $2.13", () => {
      // 4.27 / 2 = 2.135 -> half-away-from-zero rounds to 2.14.
      expect(perUnitPrice(4.27, 2)).toBe(2.14);
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
  const ctx = { productId: "p1", category: "Beverages", qtyPieces: 1, qtyUnits: 1 };
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
    over: Partial<{
      productId: string;
      category: string | null;
      qtyPieces: number;
      qtyUnits: number;
    }> = {},
  ) => ({
    productId: "p1",
    category: "Beverages",
    qtyPieces: 1,
    qtyUnits: 1,
    ...over,
  });

  it("PERCENT lowers the price and records the pre-promo original", () => {
    const r = applyBestPromotion(100, [promo({ id: "a", type: "PERCENT", value: 10 })], ctx());
    expect(r.unitPrice).toBe(90);
    expect(r.originalPrice).toBe(100);
    expect(r.appliedPromoId).toBe("a");
    // A price promo carries freeUnits: 0 — only BUY_N_GET_M ever gives units
    // away (ported from mobile's __tests__/pricing.test.ts, which asserted
    // this via a full toEqual on the result; the assertion wasn't otherwise
    // pinned here — see the p3 deviation note).
    expect(r.freeUnits).toBe(0);
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
      freeUnits: 0,
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
      freeUnits: 0,
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
      qtyUnits: norm.boxes ?? norm.qty,
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

  it("REGRESSION PIN: an existing PERCENT scenario is bit-for-bit unchanged after adding BUY_N_GET_M", () => {
    // Re-runs the exact scenario from "picks the promo that yields the lowest net
    // price" above — locks that the savings-based comparison never perturbs
    // legacy PERCENT/FIXED/QTY_BREAK output.
    const promos = [
      promo({ id: "a", type: "PERCENT", value: 10 }),
      promo({ id: "b", type: "FIXED", value: 25 }),
      promo({ id: "c", type: "PERCENT", value: 5 }),
    ];
    expect(applyBestPromotion(100, promos, ctx({ qtyUnits: 7 }))).toEqual({
      unitPrice: 75,
      originalPrice: 100,
      appliedPromoId: "b",
      freeUnits: 0,
    });
  });

  it("REGRESSION PIN: with zero whole selling units the deepest discount still wins", () => {
    // A boxed line holding only loose pieces normalizes to boxes = 0, so every
    // price promo's dollar saving is $0. The winner must still be the LOWEST net
    // price — never whichever promo id happens to sort first.
    const promos = [
      promo({ id: "aaa", type: "PERCENT", value: 5 }), // → 95
      promo({ id: "zzz", type: "PERCENT", value: 50 }), // → 50
    ];
    expect(applyBestPromotion(100, promos, ctx({ qtyPieces: 5, qtyUnits: 0 }))).toEqual({
      unitPrice: 50,
      originalPrice: 100,
      appliedPromoId: "zzz",
      freeUnits: 0,
    });
  });
});

// ─── BUY_N_GET_M ("buy N get M free") ─────────────────────────────────────────

describe("promoBogoFreeUnits (via applyBestPromotion) — the owner's exact table", () => {
  const bogo = (id: string, n: number, m: number) =>
    promo({ id, type: "BUY_N_GET_M", minQty: n, value: m });
  const ctxUnits = (qtyUnits: number) => ({
    productId: "p1",
    category: "Beverages",
    qtyPieces: qtyUnits,
    qtyUnits,
  });

  it.each([
    [5, 0],
    [6, 1],
    [11, 1],
    [12, 2],
    [18, 3],
  ])("N=5,M=1: %i whole units → %i free", (qtyUnits, expectedFree) => {
    const r = applyBestPromotion(35, [bogo("a", 5, 1)], ctxUnits(qtyUnits));
    expect(r.freeUnits).toBe(expectedFree);
    if (expectedFree > 0) {
      expect(r.appliedPromoId).toBe("a");
      expect(r.unitPrice).toBe(35); // unit price is NEVER faked for this type
      expect(r.originalPrice).toBeNull(); // no strikethrough — it's not a net-price promo
    } else {
      expect(r.appliedPromoId).toBeNull();
    }
  });

  it("PIECES NEVER COUNT: a boxed line's loose pieces never earn or receive free units", () => {
    // 5 whole boxes + 40 loose pieces (way more than a 6th box) — still 0 free,
    // because ctx.qtyUnits is whole SELLING units only (boxes), never pieces.
    const r5 = applyBestPromotion(35, [bogo("a", 5, 1)], {
      productId: "p1",
      category: "Beverages",
      qtyPieces: 5 * 24 + 40, // pieces the caller would compute — irrelevant here
      qtyUnits: 5, // 5 whole boxes; the 40 loose pieces never count
    });
    expect(r5.freeUnits).toBe(0);
    expect(r5.appliedPromoId).toBeNull();

    // The 6th WHOLE box (not more loose pieces) is what earns the free unit.
    const r6 = applyBestPromotion(35, [bogo("a", 5, 1)], {
      productId: "p1",
      category: "Beverages",
      qtyPieces: 6 * 24,
      qtyUnits: 6,
    });
    expect(r6.freeUnits).toBe(1);
    expect(r6.appliedPromoId).toBe("a");
  });

  it("EXACTNESS: $35 base × 12 boxes, 2 free, is exactly $350.00 — never a rounded net-unit-price", () => {
    // The naive (and WRONG) approach nets 35 × 5/6 = 29.1667 → rounds to 29.17,
    // then 29.17 × 12 = 350.04 — a 4-cent drift. The correct mechanic keeps the
    // true unitPrice and subtracts whole free units from the SUBTOTAL instead.
    const r = applyBestPromotion(35, [bogo("a", 5, 1)], {
      productId: "p1",
      category: "Beverages",
      qtyPieces: 12,
      qtyUnits: 12,
    });
    expect(r.freeUnits).toBe(2);
    expect(r.unitPrice).toBe(35); // base, unrounded-down, never a fake net price
    const naiveDriftedNet = roundMoney((35 * 5) / 6); // 29.17 — the impossible drift value
    expect(r.unitPrice).not.toBe(naiveDriftedNet);

    const subtotal = computeLineSubtotal({
      unitPrice: r.unitPrice,
      qty: 12,
      boxes: 12,
      pieces: 0,
      unitsPerBox: 6,
      freeUnits: r.freeUnits,
    });
    expect(subtotal).toBe(350);
    expect(subtotal).not.toBe(roundMoney(naiveDriftedNet * 12)); // 350.04 — guard the drift bug
  });

  it("computeLineSubtotal(freeUnits) clamps to the available whole units — never negative", () => {
    // Only 3 boxes on the line; freeUnits (a stale/over-generous snapshot) can
    // never take the subtotal below 0.
    expect(
      computeLineSubtotal({
        unitPrice: 35,
        qty: 18,
        boxes: 3,
        pieces: 0,
        unitsPerBox: 6,
        freeUnits: 9,
      }),
    ).toBe(0);
  });

  it("computeLineSubtotal defaults freeUnits to 0 — every existing call site is unaffected", () => {
    expect(computeLineSubtotal({ unitPrice: 220, qty: 2 })).toBe(440);
    expect(
      computeLineSubtotal({ unitPrice: 220, qty: 22, boxes: 2, pieces: 0, unitsPerBox: 11 }),
    ).toBe(440);
  });

  it("computeLineSubtotal(freeUnits) on a non-boxed (piece-priced) line subtracts whole pieces", () => {
    // Piece product: 6 pieces @ $2, N=5 M=1 → 1 free piece → 5 × $2 = $10.
    expect(computeLineSubtotal({ unitPrice: 2, qty: 6, freeUnits: 1 })).toBe(10);
  });

  it("best-of vs a PERCENT promo — BOTH directions, savings-based (not net-price-based)", () => {
    const ctxUnits12 = { productId: "p1", category: "Beverages", qtyPieces: 12, qtyUnits: 12 };
    // Direction 1: BOGO (saves $70 = 2 × $35) beats a modest 10% PERCENT (saves $42 = $3.50 × 12).
    const beatsPercent = applyBestPromotion(
      35,
      [bogo("bogo", 5, 1), promo({ id: "pct", type: "PERCENT", value: 10 })],
      ctxUnits12,
    );
    expect(beatsPercent.appliedPromoId).toBe("bogo");
    expect(beatsPercent.freeUnits).toBe(2);
    expect(beatsPercent.unitPrice).toBe(35);

    // Direction 2: a steep 50% PERCENT (saves $210 = $17.50 × 12) beats the same BOGO ($70).
    const percentWins = applyBestPromotion(
      35,
      [bogo("bogo", 5, 1), promo({ id: "pct", type: "PERCENT", value: 50 })],
      ctxUnits12,
    );
    expect(percentWins.appliedPromoId).toBe("pct");
    expect(percentWins.freeUnits).toBe(0);
    expect(percentWins.unitPrice).toBe(17.5);
    expect(percentWins.originalPrice).toBe(35);
  });

  it("value/minQty validation guards: non-integer or < 1 N/M is ignored, never a crash", () => {
    const cases: PromotionRule[] = [
      bogo("a", 0, 1), // N < 1
      bogo("a", 5, 0), // M < 1
      bogo("a", 5.5, 1), // N non-integer
      bogo("a", 5, 1.5), // M non-integer
      bogo("a", -5, 1), // N negative
      promo({ id: "a", type: "BUY_N_GET_M", minQty: null, value: 1 }), // N missing
    ];
    for (const rule of cases) {
      expect(() => applyBestPromotion(35, [rule], ctxUnits(12))).not.toThrow();
      const r = applyBestPromotion(35, [rule], ctxUnits(12));
      expect(r.appliedPromoId).toBeNull();
      expect(r.freeUnits).toBe(0);
      expect(r.unitPrice).toBe(35);
    }
  });

  it("respects scope — a BUY_N_GET_M promo scoped to another product never applies", () => {
    const scoped = promo({
      id: "a",
      type: "BUY_N_GET_M",
      minQty: 5,
      value: 1,
      scope: "PRODUCTS",
      productIds: ["other"],
    });
    const r = applyBestPromotion(35, [scoped], ctxUnits(12));
    expect(r.appliedPromoId).toBeNull();
    expect(r.freeUnits).toBe(0);
  });
});

// ─── REG-B109: applyBestPromotion must select by money ACTUALLY billed ────────
// (R3/T-B109) On a mixed box+piece line, the old saving basis for price promos
// — `(base - net) * qtyUnits` — counts only WHOLE boxes, silently dropping the
// loose pieces from the comparison even though `computeLineSubtotal` bills
// them. A BUY_N_GET_M line's saving (`freeUnits * base`) is exact because a
// free unit is always a whole box. That mismatch lets a worse-for-the-buyer
// BOGO promo "win" over a PERCENT promo that would truly bill less. The fix
// computes each candidate's saving via the SAME computeLineSubtotal path
// billing uses, on the full entered quantity — see the register's worked case.
describe("applyBestPromotion — REG-B109 selects by money actually billed (mixed box+piece lines)", () => {
  // Register's worked case: 2 boxes + 23 pieces of a 24-pack @ $120/box.
  // Full-price bill: 120 * (2 + 23/24) = 355.00.
  // The ctx carries the line's real box/piece split — that IS the fix's contract:
  // 71 pieces + 2 whole units cannot be decomposed back into boxes/upb (24 and 35
  // both fit), so the caller must hand over the denomination it already holds.
  const line = {
    productId: "p1",
    category: "Beverages",
    qtyPieces: 71,
    qtyUnits: 2,
    boxes: 2,
    pieces: 23,
    unitsPerBox: 24,
  };
  const bogo = promo({ id: "bogo", type: "BUY_N_GET_M", minQty: 1, value: 1 }); // buy 1 get 1 free
  const pct = promo({ id: "pct", type: "PERCENT", value: 49 });

  it("REG-B109: PERCENT truly saves more than BOGO on the mixed line and must be selected, billing $181.05 not $235.00", () => {
    // BOGO: 1 free box (floor(2/(1+1))*1=1) -> bills 120*(2-1+23/24) = 235.00, saves 120.00.
    // PERCENT: net = 120*(1-49/100) = 61.20 -> bills 61.20*(2+23/24) = 181.05, saves 173.95.
    // 173.95 > 120.00, so PERCENT must win — today's buggy basis compares
    // BOGO's exact 120.00 against PERCENT's truncated (120-61.20)*2 = 117.60
    // and picks BOGO instead.
    const result = applyBestPromotion(120, [bogo, pct], line);
    expect(result.appliedPromoId).toBe("pct");
    expect(result.unitPrice).toBe(61.2);
    expect(result.originalPrice).toBe(120);
    expect(result.freeUnits).toBe(0);

    const billed = computeLineSubtotal({
      unitPrice: result.unitPrice,
      qty: 71,
      boxes: 2,
      pieces: 23,
      unitsPerBox: 24,
      freeUnits: result.freeUnits,
    });
    expect(billed).toBe(181.05);
    expect(billed).not.toBe(235.0); // guard: the BOGO overcharge this bug produces today
  });
});

// Whole-box-only control (R3/T-B109 guard against over-correction): kept
// OUT of the REG-B109 describe above (and titled without that token) because
// it already passes today — with no loose pieces, boxEquivalent == qtyUnits
// exactly, so the old and new saving bases agree. It must keep picking the
// same promo after the fix, proving the fix doesn't flip an already-correct
// whole-box selection.
describe("applyBestPromotion — whole-box-only control (guards T-B109 against over-correction)", () => {
  it("keeps picking BOGO on a whole-box-only line where both saving bases already agree", () => {
    const line = { productId: "p1", category: "Beverages", qtyPieces: 144, qtyUnits: 6 };
    const bogo = promo({ id: "bogo", type: "BUY_N_GET_M", minQty: 1, value: 1 });
    const pct = promo({ id: "pct", type: "PERCENT", value: 49 });
    // BOGO: 3 free boxes (floor(6/2)*1=3) -> saves 3*120 = 360.00.
    // PERCENT: net=61.20 -> saves (120-61.20)*6 = 352.80 under EITHER basis
    // (no loose pieces means the two bases can't disagree here).
    const result = applyBestPromotion(120, [bogo, pct], line);
    expect(result.appliedPromoId).toBe("bogo");
    expect(result.freeUnits).toBe(3);

    const billed = computeLineSubtotal({
      unitPrice: result.unitPrice,
      qty: 144,
      boxes: 6,
      pieces: 0,
      unitsPerBox: 24,
      freeUnits: result.freeUnits,
    });
    expect(billed).toBe(360); // 3 of 6 boxes free @ $120 = $360.00
  });
});

describe("promotion zero-price guard (2026-08-20 $0.00 incident)", () => {
  // A miniature catalogue in the shape the operator's promotion editor and the
  // API both scan: `price` is the SELLING-UNIT price (the box price when boxed).
  const catalog: PromoScopeProduct[] = [
    { id: "p1", name: "Lighter 5-pack", category: "Novelty", price: 4.5 },
    { id: "p2", name: "Soda 24-case", category: "Beverages", price: 35 },
    { id: "p3", name: "Energy drink case", category: "Beverages", price: 35.01 },
    { id: "p4", name: "Cigar box", category: "Tobacco", price: 120 },
    { id: "p5", name: "Free sample", category: "Novelty", price: 0 },
    { id: "p6", name: "Chips box", category: "Snacks", price: "18.75" }, // Decimal-as-string
  ];

  describe("ruleCanZeroPrice — the cheap shape check that skips the scan", () => {
    it("is true for every FIXED amount (some product is always cheap enough)", () => {
      expect(ruleCanZeroPrice({ type: "FIXED", value: 0.5 })).toBe(true);
      expect(ruleCanZeroPrice({ type: "FIXED", value: 35 })).toBe(true);
    });

    it("is false for an ordinary percentage — those can never reach $0.00", () => {
      expect(ruleCanZeroPrice({ type: "PERCENT", value: 99.99 })).toBe(false);
      expect(ruleCanZeroPrice({ type: "QTY_BREAK", value: 40 })).toBe(false);
    });

    it("is true only at a FULL 100% off", () => {
      expect(ruleCanZeroPrice({ type: "PERCENT", value: 100 })).toBe(true);
      expect(ruleCanZeroPrice({ type: "QTY_BREAK", value: 100 })).toBe(true);
    });

    it("is false for a non-positive value (such a promo never applies at all)", () => {
      expect(ruleCanZeroPrice({ type: "FIXED", value: 0 })).toBe(false);
      expect(ruleCanZeroPrice({ type: "PERCENT", value: -5 })).toBe(false);
    });
  });

  describe("promotionZeroesProduct", () => {
    it("CRITICAL: FIXED at or above the selling-unit price zeroes the product", () => {
      // The incident: "$35 off" against a $35.00 case → exactly $0.00.
      const rule = promo({ id: "a", type: "FIXED", value: 35 });
      expect(promotionZeroesProduct({ id: "p2", price: 35 }, rule)).toBe(true);
      expect(promotionZeroesProduct({ id: "p1", price: 4.5 }, rule)).toBe(true);
      // One cent above the discount survives — $0.01, not $0.00.
      expect(promotionZeroesProduct({ id: "p3", price: 35.01 }, rule)).toBe(false);
    });

    it("never counts a product already priced at $0 (the promo is not why)", () => {
      expect(
        promotionZeroesProduct(
          { id: "p5", price: 0 },
          promo({ id: "a", type: "FIXED", value: 35 }),
        ),
      ).toBe(false);
    });

    it("respects scope — an out-of-scope product is never zeroed", () => {
      const scoped = promo({
        id: "a",
        type: "FIXED",
        value: 35,
        scope: "PRODUCTS",
        productIds: ["p2"],
      });
      expect(promotionZeroesProduct({ id: "p2", price: 35 }, scoped)).toBe(true);
      expect(promotionZeroesProduct({ id: "p1", price: 4.5 }, scoped)).toBe(false);
    });

    it("judges a QTY_BREAK AT its own threshold — where the rule actually bites", () => {
      const rule = promo({ id: "a", type: "QTY_BREAK", value: 100, minQty: 12 });
      expect(promotionZeroesProduct({ id: "p2", price: 35 }, rule)).toBe(true);
      // Anything short of a full 100% never reaches $0.00.
      expect(
        promotionZeroesProduct(
          { id: "p2", price: 35 },
          promo({ id: "b", type: "QTY_BREAK", value: 99, minQty: 12 }),
        ),
      ).toBe(false);
    });

    it("accepts a Decimal-as-string price (Prisma rows come back that way)", () => {
      expect(
        promotionZeroesProduct(
          { id: "p6", price: "18.75" },
          promo({ id: "a", type: "FIXED", value: 20 }),
        ),
      ).toBe(true);
    });
  });

  describe("scanPromotionZeroPrice", () => {
    it("CRITICAL: counts every ALL-scoped product the FIXED amount would zero", () => {
      const impact = scanPromotionZeroPrice(catalog, promo({ id: "a", type: "FIXED", value: 35 }));
      // p1 ($4.50), p2 ($35.00) and p6 ($18.75) go to $0.00; p3 ($35.01) and p4
      // ($120) survive; p5 is already free so the promo is not what zeroes it.
      expect(impact.count).toBe(3);
      expect(impact.inScope).toBe(catalog.length);
      expect(impact.examples).toEqual(["Lighter 5-pack", "Soda 24-case", "Chips box"]);
    });

    it("narrows to the promotion scope — the count AND the denominator", () => {
      const byCategory = scanPromotionZeroPrice(
        catalog,
        promo({ id: "a", type: "FIXED", value: 35, scope: "CATEGORY", category: "Beverages" }),
      );
      expect(byCategory).toMatchObject({ count: 1, inScope: 2, examples: ["Soda 24-case"] });

      const byProducts = scanPromotionZeroPrice(
        catalog,
        promo({ id: "a", type: "FIXED", value: 35, scope: "PRODUCTS", productIds: ["p3", "p4"] }),
      );
      expect(byProducts).toMatchObject({ count: 0, inScope: 2, examples: [] });
    });

    it("reports a clean scan for an ordinary percentage rule", () => {
      const impact = scanPromotionZeroPrice(
        catalog,
        promo({ id: "a", type: "PERCENT", value: 40 }),
      );
      expect(impact.count).toBe(0);
      expect(impact.inScope).toBe(catalog.length);
    });

    it("catches a 100%-off rule too — the other way to reach $0.00", () => {
      const impact = scanPromotionZeroPrice(
        catalog,
        promo({ id: "a", type: "PERCENT", value: 100 }),
      );
      expect(impact.count).toBe(5); // every priced product; the already-free one is excluded
    });

    it("caps the example names but never the count", () => {
      const many: PromoScopeProduct[] = Array.from({ length: 12 }, (_, i) => ({
        id: `x${i}`,
        name: `Cheap item ${i}`,
        price: 1,
      }));
      const impact = scanPromotionZeroPrice(many, promo({ id: "a", type: "FIXED", value: 35 }));
      expect(impact.count).toBe(12);
      expect(impact.examples).toHaveLength(ZERO_PRICE_EXAMPLE_LIMIT);
    });

    it("agrees with applyBestPromotion — the count is what buyers would be charged", () => {
      const rule = promo({ id: "a", type: "FIXED", value: 35 });
      const zeroed = catalog.filter(
        (p) =>
          Number(p.price) > 0 &&
          applyBestPromotion(Number(p.price), [rule], {
            productId: p.id,
            category: p.category ?? null,
            qtyPieces: 1,
            qtyUnits: 1,
          }).unitPrice === 0,
      );
      expect(scanPromotionZeroPrice(catalog, rule).count).toBe(zeroed.length);
    });
  });

  // BUY_N_GET_M (#393) reaches its discount through FREE UNITS, not a net unit
  // price, and `promoBogoFreeUnits` requires N >= 1 — so floor(q/(N+M))*M is
  // strictly less than q and a free-unit rule can never make a line free. The
  // guard therefore ignores the mechanic entirely; these lock that reasoning so
  // nobody "fixes" the guard by scanning for something that cannot happen.
  describe("BUY_N_GET_M is out of scope by construction", () => {
    it("is never scanned — value is M (free units), not a percentage", () => {
      expect(ruleCanZeroPrice({ type: "BUY_N_GET_M", value: 1 })).toBe(false);
      // A bare `value >= 100` fallthrough would send this one on a pointless
      // full-catalogue scan.
      expect(ruleCanZeroPrice({ type: "BUY_N_GET_M", value: 100 })).toBe(false);
    });

    it("is never counted, however lopsided N and M are", () => {
      const lopsided = promo({ id: "a", type: "BUY_N_GET_M", minQty: 1, value: 500 });
      expect(promotionZeroesProduct({ id: "p2", price: 35 }, lopsided)).toBe(false);
      expect(scanPromotionZeroPrice(catalog, lopsided).count).toBe(0);
    });

    it("CRITICAL: free units never consume the whole line (N >= 1 bounds them)", () => {
      const rule = promo({ id: "a", type: "BUY_N_GET_M", minQty: 1, value: 500 });
      for (const qtyUnits of [1, 2, 6, 12, 501, 1000]) {
        const r = applyBestPromotion(35, [rule], {
          productId: "p2",
          category: "Beverages",
          qtyPieces: qtyUnits,
          qtyUnits,
        });
        expect(r.freeUnits).toBeLessThan(qtyUnits);
        expect(r.unitPrice).toBe(35); // BOGO never rewrites the unit price
      }
    });
  });

  it("zeroPriceWarning names the count and pluralises", () => {
    expect(zeroPriceWarning({ count: 699, inScope: 1767, examples: [] })).toBe(
      "This discount is larger than the price of 699 products in scope — they would sell for $0.00.",
    );
    expect(zeroPriceWarning({ count: 1, inScope: 4, examples: [] })).toBe(
      "This discount is larger than the price of 1 product in scope — they would sell for $0.00.",
    );
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
