/**
 * Pins the STAND-IN classifier (legacy-line-pieces.stub.ts) to the Senior Architect's evidence order of
 * 2026-09-21: (a) own split, (b) a same-product source line WITH a split read by comparing quantities,
 * (c) otherwise unknown; never a multiplication by a pack. Deleted together with the stub when U-units'
 * real one lands in @routeflow/pricing.
 */
import { legacyLinePieces } from "./legacy-line-pieces.stub";

const line = (over: Record<string, unknown> = {}) => ({
  qty: 6,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  ...over,
});
/** A same-product source line with a split: 6 boxes of 12 = 72 pieces. */
const source = (over: Record<string, unknown> = {}) =>
  line({ qty: 72, boxes: 6, pieces: 0, unitsPerBox: 12, ...over });

describe("legacyLinePieces (stand-in)", () => {
  it("(a) a stored split means qty already counts pieces", () => {
    expect(legacyLinePieces(line({ qty: 72, boxes: 6, pieces: 0, unitsPerBox: 12 }))).toEqual({
      pieces: 72,
      basis: "split",
    });
    expect(legacyLinePieces(line({ qty: 5, boxes: null, pieces: 5 }))).toEqual({
      pieces: 5,
      basis: "split",
    });
  });

  it("(b) source-boxes: qty equals the source's boxes (and not its qty) -> pieces = source.qty", () => {
    expect(legacyLinePieces(line({ qty: 6 }), source())).toEqual({
      pieces: 72,
      basis: "source-boxes",
    });
  });

  it("(b) source-pieces: qty equals the source's qty -> pieces = qty (never multiplied)", () => {
    expect(legacyLinePieces(line({ qty: 72 }), source())).toEqual({
      pieces: 72,
      basis: "source-pieces",
    });
  });

  it("(b) a qty matching neither the source's boxes nor its qty is UNKNOWN", () => {
    expect(legacyLinePieces(line({ qty: 10 }), source())).toMatchObject({ unknown: true });
  });

  it("(b) when boxes equals qty on the source (1 box of 1) it reads as pieces, not boxes", () => {
    expect(legacyLinePieces(line({ qty: 1 }), source({ qty: 1, boxes: 1, pieces: 0 }))).toEqual({
      pieces: 1,
      basis: "source-pieces",
    });
  });

  it("the B644/B656 shape (qty 72, unitsPerBox 12, no split) is NOT evidence: unknown without a source, never 864", () => {
    const shape = line({ qty: 72, unitsPerBox: 12 });
    expect(legacyLinePieces(shape)).toMatchObject({ unknown: true });
    expect(legacyLinePieces(shape, null)).toMatchObject({ unknown: true });
    // with a source it is read by comparing quantities, still never multiplied
    expect(legacyLinePieces(shape, source())).toEqual({ pieces: 72, basis: "source-pieces" });
  });

  it("(c) no source, or a source WITHOUT a split, is UNKNOWN", () => {
    expect(legacyLinePieces(line())).toMatchObject({ unknown: true });
    expect(legacyLinePieces(line(), null)).toMatchObject({ unknown: true });
    expect(legacyLinePieces(line(), line({ qty: 72, unitsPerBox: 12 }))).toMatchObject({
      unknown: true,
    });
  });
});
