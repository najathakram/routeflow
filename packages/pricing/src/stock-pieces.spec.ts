import { linePieceQty, sumPiecesByProduct, toPieces } from "./stock-pieces";

/**
 * SA-1086: the ONE line-to-pieces conversion and the ONE per-product sum that the order save
 * (`decrementStockForSale`) and the live stock note on the order screens both read. These cases pin
 * the numbers the save has always used (B703, B920) now that they live in a shared package.
 */
describe("linePieceQty / toPieces (the save's conversion)", () => {
  it("a box-unaware boxed line is boxes x the live pack: 2 of a 12-pack is 24", () => {
    expect(toPieces({}, 2, 12)).toBe(24);
    expect(linePieceQty({ qty: 2, boxes: null }, 12)).toBe(24);
  });

  it("the line's own pack snapshot is read first by callers, the live pack is the fallback only", () => {
    expect(linePieceQty({ qty: 2, boxes: null, unitsPerBox: 6 }, 12)).toBe(12);
  });

  it("a box-split line already holds pieces: qty is not multiplied again", () => {
    expect(toPieces({ boxes: 2, pieces: 3, unitsPerBox: 12 }, 27, 12)).toBe(27);
    expect(toPieces({ boxes: null, pieces: 5 }, 5, 12)).toBe(5);
  });

  it("a named-unit line counts that unit as is", () => {
    expect(toPieces({ unitLabel: "Case" }, 3, 12)).toBe(3);
  });

  it("a plain product (no pack, or a pack of 1) is qty", () => {
    expect(toPieces({}, 7, null)).toBe(7);
    expect(toPieces({}, 7, 1)).toBe(7);
    expect(toPieces({}, 7, undefined)).toBe(7);
  });

  it("rounds to the stock column's 3 decimals", () => {
    expect(toPieces({}, 0.12345, null)).toBe(0.123);
  });

  it("accepts the Decimal-like values a stored row carries", () => {
    expect(toPieces({ boxes: "2" }, "24", "12")).toBe(24);
  });
});

describe("sumPiecesByProduct (B920: judge the product, never the line)", () => {
  it("sums two lines of one product before anything is compared", () => {
    const sums = sumPiecesByProduct([
      { productId: "p1", pieces: 6 },
      { productId: "p1", pieces: 6 },
      { productId: "p2", pieces: 1 },
    ]);
    expect(sums.get("p1")).toBe(12);
    expect(sums.get("p2")).toBe(1);
  });

  it("keeps first-seen order and the 3-decimal rounding of the sum", () => {
    const sums = sumPiecesByProduct([
      { productId: "b", pieces: 0.1 },
      { productId: "a", pieces: 0.2 },
      { productId: "b", pieces: 0.2 },
    ]);
    expect([...sums.keys()]).toEqual(["b", "a"]);
    expect(sums.get("b")).toBe(0.3);
  });
});
