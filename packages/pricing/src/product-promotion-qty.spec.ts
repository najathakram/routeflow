import { applyBestPromotion, type PromotionRule } from "./pricing";
import { allocateFreeUnits, productPromotionQty } from "./product-promotion-qty";

/**
 * B297 row 355: the product's promotion quantity is the COMBINED quantity of its lines, each read from its
 * own unit fields; free units are allocated oldest line first, capped at each line's selling units.
 */
const QTY_BREAK_12: PromotionRule = {
  id: "qb",
  type: "QTY_BREAK",
  value: 10,
  minQty: 12,
  scope: "ALL",
};
const BOGO_5_1: PromotionRule = {
  id: "bogo",
  type: "BUY_N_GET_M",
  value: 1,
  minQty: 5,
  scope: "ALL",
};
const ctxOf = (q: ReturnType<typeof productPromotionQty>) => ({ productId: "p1", ...q });

describe("productPromotionQty", () => {
  it("sums plain lines of an unboxed product", () => {
    expect(productPromotionQty([{ qty: 6 }, { qty: 6 }], null)).toMatchObject({
      qtyPieces: 12,
      qtyUnits: 12,
    });
  });

  it("reads a pack line as selling units and a box-split line as pieces, never mixed up", () => {
    // pack line: 2 boxes (qty 2, no split) = 24 pieces; box-split line: 24 pieces = 2 boxes + 0
    const q = productPromotionQty([{ qty: 2 }, { qty: 24, boxes: 2, pieces: 0 }], 12);
    expect(q).toMatchObject({ qtyPieces: 48, qtyUnits: 4, boxes: 4, pieces: 0, unitsPerBox: 12 });
  });

  it("loose pieces from different lines combine into a whole box", () => {
    const q = productPromotionQty(
      [
        { qty: 6, boxes: 0, pieces: 6 },
        { qty: 6, boxes: 0, pieces: 6 },
      ],
      12,
    );
    expect(q).toMatchObject({ qtyPieces: 12, qtyUnits: 1, boxes: 1, pieces: 0 });
  });
});

describe("allocateFreeUnits", () => {
  it("fills the oldest line first, capped at its units", () => {
    expect(allocateFreeUnits(2, [1, 10])).toEqual([1, 1]);
    expect(allocateFreeUnits(2, [6, 6])).toEqual([2, 0]);
  });

  it("never allocates more than the total, and tolerates caps that run out", () => {
    expect(allocateFreeUnits(5, [1, 1])).toEqual([1, 1]);
    expect(allocateFreeUnits(0, [3, 3])).toEqual([0, 0]);
    expect(allocateFreeUnits(-1, [3])).toEqual([0]);
  });
});

describe("a split line set meets the promotion a single line would", () => {
  it("6 + 6 meets a 12-unit QTY_BREAK that neither half meets alone", () => {
    const alone = applyBestPromotion(
      10,
      [QTY_BREAK_12],
      ctxOf(productPromotionQty([{ qty: 6 }], null)),
    );
    expect(alone.appliedPromoId).toBeNull();
    const combined = applyBestPromotion(
      10,
      [QTY_BREAK_12],
      ctxOf(productPromotionQty([{ qty: 6 }, { qty: 6 }], null)),
    );
    expect(combined.appliedPromoId).toBe("qb");
    expect(combined.unitPrice).toBe(9);
  });

  it("buy-5-get-1 on 7 + 5 earns what one 12-unit line earns (2), allocated oldest first", () => {
    const single = applyBestPromotion(
      10,
      [BOGO_5_1],
      ctxOf(productPromotionQty([{ qty: 12 }], null)),
    );
    const split = applyBestPromotion(
      10,
      [BOGO_5_1],
      ctxOf(productPromotionQty([{ qty: 7 }, { qty: 5 }], null)),
    );
    expect(split.freeUnits).toBe(single.freeUnits);
    expect(split.freeUnits).toBe(2);
    expect(allocateFreeUnits(split.freeUnits, [7, 5])).toEqual([2, 0]);
  });
});
