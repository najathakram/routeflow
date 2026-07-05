import {
  computeLineSubtotal,
  roundMoney,
  normalizeBoxesPieces,
  costPerSellingUnit,
  computeMarginFraction,
  priceForMarginFloor,
  classifyMargin,
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
