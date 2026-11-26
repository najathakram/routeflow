import { BUYER_LINE_QTY_MAX, buyerLineOverCap, buyerLinePieces } from "./unit-price-limit";

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
