import { legacyLinePieces } from "./legacy-line-pieces";

/**
 * legacyLinePieces — ruled once by the Senior Architect, with a HOLD round fixing the ruling
 * itself (#938, 2026-09-21). Signature and evidence order are canonical; B661/B646/the history
 * report and Lane B's B660/B665/B671 all import this — see the file header.
 */
describe("legacyLinePieces", () => {
  describe("(a) the line itself carries a split", () => {
    it("boxes given: pieces = qty, basis split", () => {
      expect(legacyLinePieces({ qty: 72, boxes: 6, pieces: 0, unitsPerBox: 12 })).toEqual({
        pieces: 72,
        basis: "split",
      });
    });

    it("pieces given (boxes null): still a split — the definition is boxes OR pieces given", () => {
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

    it("an unusable line qty is unknown before anything else runs", () => {
      const result = legacyLinePieces({ qty: NaN, boxes: 6, pieces: 0 });
      expect(result).toMatchObject({ unknown: true });
    });
  });

  describe('(b) relation "full" — a line against the ONE line it was copied from whole', () => {
    it("MONEY: qty matches the source's BOXES (not its qty) — pieces = source.qty, basis source-boxes", () => {
      // The B641/B661 shape: a copier wrote qty = the SOURCE order line's box count (6), losing
      // the split. The source itself is a real 6-box-of-12 line: qty 72, boxes 6, no loose pieces.
      expect(
        legacyLinePieces(
          { qty: 6, boxes: null, pieces: null },
          { qty: 72, boxes: 6, pieces: 0 },
          { relation: "full" },
        ),
      ).toEqual({ pieces: 72, basis: "source-boxes" });
    });

    it("qty matches the source's QTY — pieces = qty, basis source-pieces", () => {
      expect(
        legacyLinePieces(
          { qty: 72, boxes: null, pieces: null },
          { qty: 72, boxes: 6, pieces: 0 },
          { relation: "full" },
        ),
      ).toEqual({ pieces: 72, basis: "source-pieces" });
    });

    it("a tie (source.boxes === source.qty) resolves to source-pieces, never source-boxes", () => {
      // Only possible when the source itself is a factor-1 line (1 box of a 1-pack): boxes=1,
      // qty=1. The "!== source.qty" guard on source-boxes fails, falling through to source-pieces.
      expect(
        legacyLinePieces(
          { qty: 1, boxes: null, pieces: null },
          { qty: 1, boxes: 1, pieces: 0 },
          { relation: "full" },
        ),
      ).toEqual({ pieces: 1, basis: "source-pieces" });
    });

    it("HOLD: a source with LOOSE PIECES (2 boxes + 3) — qty matching its boxes is unknown, never 27", () => {
      // A box-count copy of "2 boxes + 3 loose" would have lost the 3 loose pieces too, so a
      // coincidental qty(2) === source.boxes(2) here is NOT evidence of that copy — it's just as
      // likely a genuine, unrelated 2-piece sale. Senior Architect HOLD, 2026-09-21.
      const result = legacyLinePieces(
        { qty: 2, boxes: null, pieces: null },
        { qty: 27, boxes: 2, pieces: 3 },
        { relation: "full" },
      );
      expect(result).toMatchObject({ unknown: true });
    });

    it("qty matches NEITHER axis — unknown, never a guess", () => {
      const result = legacyLinePieces(
        { qty: 5, boxes: null, pieces: null },
        { qty: 72, boxes: 6, pieces: 0 },
        { relation: "full" },
      );
      expect(result).toMatchObject({ unknown: true });
      expect((result as { reason: string }).reason).toMatch(/neither/);
    });

    it("the source itself has no split — unusable, unknown", () => {
      const result = legacyLinePieces(
        { qty: 6, boxes: null, pieces: null },
        { qty: 6, boxes: null, pieces: null },
        { relation: "full" },
      );
      expect(result).toMatchObject({ unknown: true });
    });
  });

  describe('(b) relation "partial" (the DEFAULT) — box-count inference is disabled entirely', () => {
    it("HOLD (B660 shape): 5 pieces of a 5-box order line is unknown, NEVER 12x as source-boxes", () => {
      // A 5-box-of-12 order line: qty 60, boxes 5. A partial invoice/return of 5 PIECES against
      // it has qty(5) === source.boxes(5) by pure coincidence — under "full" this would wrongly
      // read as source-boxes -> 60 (12x over). Default relation is "partial": only qty===source.qty
      // may fire, so this must be unknown, not 60. Senior Architect HOLD, 2026-09-21.
      const result = legacyLinePieces(
        { qty: 5, boxes: null, pieces: null },
        { qty: 60, boxes: 5, pieces: 0 },
        // relation omitted — proves the default is "partial", the safe direction
      );
      expect(result).toMatchObject({ unknown: true });
      expect((result as { reason: string }).reason).toMatch(/partial/);
    });

    it("qty matches the source's qty — source-pieces still fires under partial (a genuine full-qty partial)", () => {
      expect(
        legacyLinePieces({ qty: 60, boxes: null, pieces: null }, { qty: 60, boxes: 5, pieces: 0 }),
      ).toEqual({ pieces: 60, basis: "source-pieces" });
    });

    it('explicit relation: "partial" behaves exactly like the default', () => {
      const result = legacyLinePieces(
        { qty: 5, boxes: null, pieces: null },
        { qty: 60, boxes: 5, pieces: 0 },
        { relation: "partial" },
      );
      expect(result).toMatchObject({ unknown: true });
    });
  });

  describe("(c) non-boxed-now fallback — opt-in only, via opts.productPackNow", () => {
    it('HOLD: an ordinary NEVER-BOXED product (no split, no source) is "non-boxed-now", not unknown', () => {
      // The flood the Senior Architect flagged: a product that was never boxed has no split and
      // usually no usable source either, so without this fallback EVERY such line was unknown.
      const result = legacyLinePieces({ qty: 4, boxes: null, pieces: null }, null, {
        productPackNow: 1,
      });
      expect(result).toEqual({ pieces: 4, basis: "non-boxed-now" });
    });

    it("productPackNow: null (checked, no live pack info) also counts as not-boxed-now", () => {
      const result = legacyLinePieces({ qty: 4, boxes: null, pieces: null }, null, {
        productPackNow: null,
      });
      expect(result).toEqual({ pieces: 4, basis: "non-boxed-now" });
    });

    it("productPackNow boxed (> 1) does NOT trigger the fallback — stays unknown", () => {
      const result = legacyLinePieces({ qty: 4, boxes: null, pieces: null }, null, {
        productPackNow: 12,
      });
      expect(result).toMatchObject({ unknown: true });
    });

    it("productPackNow OMITTED entirely — no free pass, stays unknown (never a wrong answer, only fewer resolutions)", () => {
      expect(legacyLinePieces({ qty: 4, boxes: null, pieces: null })).toMatchObject({
        unknown: true,
      });
      expect(
        legacyLinePieces({ qty: 4, boxes: null, pieces: null }, null, { relation: "full" }),
      ).toMatchObject({ unknown: true });
    });

    it("the fallback is checked BEFORE giving up on an unusable source, not instead of resolving one", () => {
      // A usable source that actually resolves the line takes priority over the weaker fallback.
      const result = legacyLinePieces(
        { qty: 60, boxes: null, pieces: null },
        { qty: 60, boxes: 5, pieces: 0 },
        { productPackNow: 1 }, // even though "not boxed now", a real source-pieces match wins
      );
      expect(result).toEqual({ pieces: 60, basis: "source-pieces" });
    });
  });

  describe("(d) no split and no usable source, no productPackNow — unknown", () => {
    it("no sourceLine at all", () => {
      expect(legacyLinePieces({ qty: 6, boxes: null, pieces: null })).toMatchObject({
        unknown: true,
      });
    });

    it("sourceLine explicitly null", () => {
      expect(legacyLinePieces({ qty: 6, boxes: null, pieces: null }, null)).toMatchObject({
        unknown: true,
      });
    });
  });

  it("MONEY: NEVER multiplies by unitsPerBox — a live pack size on either line changes nothing", () => {
    // If this multiplied qty(6) x unitsPerBox(12) it would wrongly return 72 here too — but under
    // "full" relation qty=6 matches NEITHER axis of a source with a DIFFERENT box size (boxes 3,
    // qty 36), so it must be unknown, not a guessed 72.
    const result = legacyLinePieces(
      { qty: 6, boxes: null, pieces: null, unitsPerBox: 12 },
      { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 },
      { relation: "full" },
    );
    expect(result).toMatchObject({ unknown: true });
  });

  describe("HOLD: Decimal-typed input (compared through Number() with a finite check)", () => {
    // A Prisma Decimal isn't a plain number but stringifies/coerces via Number() like one; a bare
    // `===` between a Decimal and a number is always false, which used to fail every row to
    // unknown silently. A minimal Decimal-like stand-in (valueOf, matching Prisma's own shape).
    const decimal = (n: number) => ({ valueOf: () => n, toString: () => String(n) }) as any;

    it("a Decimal line qty against a plain-number split still classifies", () => {
      expect(legacyLinePieces({ qty: decimal(72), boxes: 6, pieces: 0 })).toEqual({
        pieces: 72,
        basis: "split",
      });
    });

    it("a Decimal qty/boxes/pieces on the SOURCE still matches under full relation", () => {
      expect(
        legacyLinePieces(
          { qty: 6, boxes: null, pieces: null },
          { qty: decimal(72), boxes: decimal(6), pieces: decimal(0) },
          { relation: "full" },
        ),
      ).toEqual({ pieces: 72, basis: "source-boxes" });
    });

    it("a genuinely unparseable value (not a Decimal, not a number) is unknown, never a false match", () => {
      const result = legacyLinePieces({ qty: "not-a-number" as any, boxes: null, pieces: null });
      expect(result).toMatchObject({ unknown: true });
    });
  });
});
