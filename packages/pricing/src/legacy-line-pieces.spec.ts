import { legacyLinePieces } from "./legacy-line-pieces";

/**
 * legacyLinePieces — ruled once by the Senior Architect (#938, 2026-09-21). Signature and
 * evidence order are canonical; B661/B646/the history report and Lane B's B660/B665/B671 all
 * import this — see the file header.
 */
describe("legacyLinePieces", () => {
  describe("(a) the line itself carries a split", () => {
    it("boxes given: pieces = qty, basis split", () => {
      expect(legacyLinePieces({ qty: 72, boxes: 6, pieces: 0, unitsPerBox: 12 })).toEqual({
        pieces: 72,
        basis: "split",
      });
    });

    it("pieces given (boxes null): still a split — the box-only case never happens for a real row, but the definition is boxes OR pieces given", () => {
      expect(legacyLinePieces({ qty: 5, boxes: null, pieces: 5 })).toEqual({
        pieces: 5,
        basis: "split",
      });
    });

    it("a split takes priority over a sourceLine — never even looks at it", () => {
      expect(
        legacyLinePieces({ qty: 72, boxes: 6, pieces: 0 }, { qty: 999, boxes: 999, pieces: 999 }),
      ).toEqual({ pieces: 72, basis: "split" });
    });
  });

  describe("(b) no split on the line — a sourceLine with a split resolves it", () => {
    it("MONEY: qty matches the source's BOXES (not its qty) — pieces = source.qty, basis source-boxes", () => {
      // The B641/B661 shape: a copier wrote qty = the SOURCE order line's box count (6), losing
      // the split. The source itself is a real 6-box-of-12 line: qty 72, boxes 6.
      expect(
        legacyLinePieces({ qty: 6, boxes: null, pieces: null }, { qty: 72, boxes: 6, pieces: 0 }),
      ).toEqual({ pieces: 72, basis: "source-boxes" });
    });

    it("qty matches the source's QTY (not distinctly its boxes) — pieces = qty, basis source-pieces", () => {
      expect(
        legacyLinePieces({ qty: 72, boxes: null, pieces: null }, { qty: 72, boxes: 6, pieces: 0 }),
      ).toEqual({ pieces: 72, basis: "source-pieces" });
    });

    it("a tie (source.boxes === source.qty) resolves to source-pieces, never source-boxes", () => {
      // Only possible when the source itself is a factor-1 line (1 box of a 1-pack): boxes=1,
      // qty=1. The "!== source.qty" guard on source-boxes fails, falling through to source-pieces.
      expect(
        legacyLinePieces({ qty: 1, boxes: null, pieces: null }, { qty: 1, boxes: 1, pieces: 0 }),
      ).toEqual({ pieces: 1, basis: "source-pieces" });
    });

    it("qty matches NEITHER axis — unknown, never a guess", () => {
      const result = legacyLinePieces(
        { qty: 5, boxes: null, pieces: null },
        { qty: 72, boxes: 6, pieces: 0 },
      );
      expect(result).toMatchObject({ unknown: true });
      expect((result as { reason: string }).reason).toMatch(/neither/);
    });

    it("the source itself has no split — unusable, unknown", () => {
      const result = legacyLinePieces(
        { qty: 6, boxes: null, pieces: null },
        { qty: 6, boxes: null, pieces: null },
      );
      expect(result).toMatchObject({ unknown: true });
    });
  });

  describe("(c) no split and no usable source", () => {
    it("no sourceLine at all — unknown", () => {
      const result = legacyLinePieces({ qty: 6, boxes: null, pieces: null });
      expect(result).toMatchObject({ unknown: true });
    });

    it("sourceLine explicitly null — unknown", () => {
      const result = legacyLinePieces({ qty: 6, boxes: null, pieces: null }, null);
      expect(result).toMatchObject({ unknown: true });
    });
  });

  it("MONEY: NEVER multiplies by unitsPerBox — a live pack size on either line changes nothing", () => {
    // If this multiplied qty(6) x unitsPerBox(12) it would wrongly return 72 here too — but qty=6
    // matches NEITHER axis of a source with a DIFFERENT box size (boxes 3, qty 36), so it must be
    // unknown, not a guessed 72.
    const result = legacyLinePieces(
      { qty: 6, boxes: null, pieces: null, unitsPerBox: 12 },
      { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 },
    );
    expect(result).toMatchObject({ unknown: true });
  });
});
