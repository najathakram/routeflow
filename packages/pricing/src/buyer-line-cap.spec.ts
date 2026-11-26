import {
  BUYER_LINE_QTY_MAX,
  buyerCreateLinePieces,
  buyerLineOverCap,
  buyerLinePieces,
} from "./unit-price-limit";

/**
 * B1386 (SA-1285 sections 1-2): the buyer line cap counts a line's PIECE total, and is rise-only. A line written in
 * pieces counts its qty; a pack line counts qty x unitsPerBox when the pack is a whole number of 2 or more (the same
 * pack rule as `maxLineCount`), else qty.
 */
describe("buyerLinePieces (B1386)", () => {
  it.each([
    // [qty, inPieces, unitsPerBox, pieces]
    [100_001, false, null, 100_001],
    [100_001, false, 1, 100_001],
    [8_334, false, 12, 100_008],
    [8_333, false, 12, 99_996],
    [100_001, true, 12, 100_001], // a box-split line's qty is already pieces
    [10, false, 1.5, 10], // a fractional pack is no pack
    [10, false, "12", 120], // a numeric string pack (Prisma Decimal / JSON) counts
    [100_000.001, false, 0, 100_000.001],
  ])("qty %p, inPieces %p, pack %p -> %p pieces", (qty, inPieces, upb, pieces) => {
    expect(buyerLinePieces(qty as number, inPieces as boolean, upb)).toBe(pieces);
  });
});

describe("buyerLineOverCap (B1386, rise-only)", () => {
  it("the cap is 100,000 pieces", () => {
    expect(BUYER_LINE_QTY_MAX).toBe(100_000);
  });
  it.each([
    // [pieces, storedPieces, over]
    [100_000, 0, false],
    [100_001, 0, true],
    [100_000.001, 0, true],
    [120_000, 120_000, false], // an existing large line resent unchanged
    [110_000, 120_000, false], // lowered but still above the cap
    [130_000, 120_000, true], // raised further
    [100_001, undefined, true],
    [NaN, 0, true], // fail closed
    [Infinity, 0, true],
  ])("pieces %p over stored %p -> %p", (pieces, stored, over) => {
    expect(buyerLineOverCap(pieces as number, stored as number | undefined)).toBe(over);
  });
});

/**
 * B1386 (order CREATE): the piece total create builds. A plain qty counts PACKS (SA-601); a named split is
 * boxes x pack + pieces (normalizeBoxesPieces), so one field alone can be under 100,000 while the line is not.
 */
describe("buyerCreateLinePieces (B1386)", () => {
  it.each([
    // [label, line, pieces]
    ["plain qty on a pack of 1", { qty: 100_000, unitsPerBox: 1 }, 100_000],
    ["plain qty, no pack", { qty: 7 }, 7],
    ["plain 8,334 packs on 12", { qty: 8_334, unitsPerBox: 12 }, 100_008],
    ["plain 8,333 packs on 12", { qty: 8_333, unitsPerBox: 12 }, 99_996],
    [
      "one qty, 100,000 boxes on 12",
      { qty: 1, boxes: 100_000, pieces: 0, unitsPerBox: 12 },
      1_200_000,
    ],
    [
      "split 8,333 boxes + 4 pieces on 12",
      { qty: 1, boxes: 8_333, pieces: 4, unitsPerBox: 12 },
      100_000,
    ],
    ["pieces only roll up on 12", { qty: 1, pieces: 25, unitsPerBox: 12 }, 25],
    ["a split on a pack of 1 keeps qty", { qty: 5, boxes: 100_000, pieces: 0, unitsPerBox: 1 }, 5],
    ["a zero split is a plain qty", { qty: 3, boxes: 0, pieces: 0, unitsPerBox: 12 }, 36],
    ["a fractional pack is no pack (plain)", { qty: 10, unitsPerBox: 2.5 }, 10],
    [
      "a fractional pack is no pack (split)",
      { qty: 10, boxes: 4, pieces: 0, unitsPerBox: 2.5 },
      10,
    ],
    ["a missing pack is no pack", { qty: 10, boxes: 4, unitsPerBox: null }, 10],
    ["a numeric-string pack counts", { qty: 2, unitsPerBox: "12" }, 24],
  ])("%s", (_label, line, pieces) => {
    expect(buyerCreateLinePieces(line as Parameters<typeof buyerCreateLinePieces>[0])).toBe(pieces);
  });

  it("is over the cap exactly when create's built total is", () => {
    const over = (l: Parameters<typeof buyerCreateLinePieces>[0]) =>
      buyerLineOverCap(buyerCreateLinePieces(l), 0);
    expect(over({ qty: 1, boxes: 100_000, pieces: 0, unitsPerBox: 12 })).toBe(true);
    expect(over({ qty: 8_334, unitsPerBox: 12 })).toBe(true);
    expect(over({ qty: 8_333, unitsPerBox: 12 })).toBe(false);
    expect(over({ qty: 1, boxes: 8_333, pieces: 4, unitsPerBox: 12 })).toBe(false);
    expect(over({ qty: 100_000, unitsPerBox: 1 })).toBe(false);
  });
});
