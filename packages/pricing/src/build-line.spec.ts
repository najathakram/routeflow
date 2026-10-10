import { buildLine } from "./build-line";
import { AmbiguousLineError } from "./pricing";

/**
 * `buildLine` — PR-1 of the "refuse ambiguity" design (#938, 2026-09-21). NO CALLERS yet; this
 * spec is the only thing exercising it. See build-line.ts's header for the two axes.
 */
describe("buildLine — pack axis", () => {
  it("MONEY: a boxed product with a real split prices per BOX, never qty x unitPrice", () => {
    const line = buildLine({
      axis: { kind: "pack", boxes: 6, pieces: 0, unitsPerBox: 12 },
      unitPrice: 40,
    });
    expect(line).toMatchObject({
      qty: 72,
      boxes: 6,
      pieces: 0,
      unitsPerBox: 12,
      unitLabel: null,
      subtotal: 240, // 6 x 40, never 72 x 40 = 2880 (the B644 shape)
    });
  });

  it("MONEY: refuses the B644 shape — a boxed product given qty alone", () => {
    expect(() =>
      buildLine({ axis: { kind: "pack", qty: 72, unitsPerBox: 12 }, unitPrice: 40 }),
    ).toThrow(AmbiguousLineError);
  });

  it("a non-boxed product prices per piece from qty alone and snapshots no box size", () => {
    const line = buildLine({ axis: { kind: "pack", qty: 4, unitsPerBox: null }, unitPrice: 5.25 });
    expect(line).toMatchObject({
      qty: 4,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitLabel: null,
      subtotal: 21,
    });
  });

  it("prorates loose pieces below a full box", () => {
    const line = buildLine({
      axis: { kind: "pack", boxes: 1, pieces: 10, unitsPerBox: 11 },
      unitPrice: 220,
    });
    expect(line.subtotal).toBe(420);
    expect(line.qty).toBe(21);
  });

  it("HOLD 2: a stale split (pieces >= unitsPerBox) is ROLLED OVER, never refused — a real split was given", () => {
    // 1 box + 15 loose of a 10-pack = 25 pieces = 2 boxes + 5, same money either way (2.5 boxes).
    // Only a MISSING split (qty alone) is the B644 ambiguity; an unrolled one is buildLine's job
    // to normalize (Senior Architect review, HOLD 2, 2026-09-21 — supersedes the prior "refuses a
    // stale split" expectation, which passed the RAW unrolled split into strict and threw).
    const line = buildLine({
      axis: { kind: "pack", boxes: 1, pieces: 15, unitsPerBox: 10 },
      unitPrice: 10,
    });
    expect(line).toMatchObject({ qty: 25, boxes: 2, pieces: 5, unitsPerBox: 10, subtotal: 25 });
  });

  it("HOLD 1: a non-boxed product's fractional qty is NEVER truncated (OrderItem.qty is Decimal(10,3))", () => {
    const line = buildLine({ axis: { kind: "pack", qty: 1.5, unitsPerBox: null }, unitPrice: 10 });
    expect(line).toMatchObject({ qty: 1.5, boxes: null, pieces: null, subtotal: 15 });
  });

  it("HOLD 1 mutation guard: a boxed product's fractional qty (impossible from a real split) still throws", () => {
    expect(() =>
      buildLine({ axis: { kind: "pack", boxes: 1.5, pieces: 0, unitsPerBox: 10 }, unitPrice: 10 }),
    ).toThrow(AmbiguousLineError);
  });

  it.each([
    [
      "boxes/pieces on a non-boxed axis (would be silently dropped)",
      { kind: "pack" as const, boxes: 1, pieces: 0, qty: 5, unitsPerBox: null },
    ],
    ["qty missing (used to price at $0)", { kind: "pack" as const, unitsPerBox: 1 }],
    ["qty NaN", { kind: "pack" as const, qty: NaN, unitsPerBox: null }],
    ["qty zero", { kind: "pack" as const, qty: 0, unitsPerBox: null }],
    ["qty negative", { kind: "pack" as const, qty: -3, unitsPerBox: null }],
  ])("G1: refuses %s", (_name, axis) => {
    expect(() => buildLine({ axis, unitPrice: 10 })).toThrow(AmbiguousLineError);
  });

  it("G3: refuses a split AND a qty that disagrees with it (never silently drops the qty)", () => {
    // boxes:1, pieces:0 of a 12-pack implies 12 pieces, not the caller's qty:5.
    expect(() =>
      buildLine({
        axis: { kind: "pack", boxes: 1, pieces: 0, qty: 5, unitsPerBox: 12 },
        unitPrice: 10,
      }),
    ).toThrow(AmbiguousLineError);
  });

  it("G3: a qty that AGREES with the raw (unrolled) split is fine, not a false positive", () => {
    // 1 box + 15 of a 10-pack is unrolled but self-consistent (1*10+15=25) — HOLD 2 rolls it
    // over to 2 boxes + 5, same 25 pieces; G3 must not flag an honest, matching qty.
    const line = buildLine({
      axis: { kind: "pack", boxes: 1, pieces: 15, qty: 25, unitsPerBox: 10 },
      unitPrice: 10,
    });
    expect(line).toMatchObject({ qty: 25, boxes: 2, pieces: 5 });
  });

  it("N1: refuses boxes:0, pieces:0 on a boxed product — used to mint a $0 line", () => {
    expect(() =>
      buildLine({ axis: { kind: "pack", boxes: 0, pieces: 0, unitsPerBox: 12 }, unitPrice: 10 }),
    ).toThrow(AmbiguousLineError);
  });
});

describe("buildLine — unit axis", () => {
  it("MONEY: 3 Cases of 288 at $480/Case is $1,440 (B641's fixture)", () => {
    const line = buildLine({
      axis: { kind: "unit", label: "Case", count: 3, factorToBase: 288 },
      unitPrice: 480,
    });
    expect(line).toEqual({
      qty: 864,
      boxes: 3,
      pieces: 0,
      unitsPerBox: 288,
      unitLabel: "Case",
      unitPrice: 480,
      subtotal: 1440,
    });
  });

  it("a factor-1 unit (a Piece off a boxed pack) is a plain per-piece line that still snapshots 1", () => {
    const line = buildLine({
      axis: { kind: "unit", label: "Piece", count: 5, factorToBase: 1 },
      unitPrice: 3.5,
    });
    expect(line).toEqual({
      qty: 5,
      boxes: null,
      pieces: null,
      unitsPerBox: 1,
      unitLabel: "Piece",
      unitPrice: 3.5,
      subtotal: 17.5,
    });
  });

  it("trims the label", () => {
    const line = buildLine({
      axis: { kind: "unit", label: "  Pallet  ", count: 1, factorToBase: 40 },
      unitPrice: 100,
    });
    expect(line.unitLabel).toBe("Pallet");
  });

  it.each([
    ["a blank label", { kind: "unit" as const, label: "   ", count: 1, factorToBase: 12 }],
    ["a zero count", { kind: "unit" as const, label: "Case", count: 0, factorToBase: 12 }],
    ["a negative count", { kind: "unit" as const, label: "Case", count: -1, factorToBase: 12 }],
    // G2 (R-ui review, 2026-09-21): Math.trunc alone billed 1.5 Cases as 1 — refuse instead.
    ["a fractional count", { kind: "unit" as const, label: "Case", count: 1.5, factorToBase: 12 }],
    ["a zero factor", { kind: "unit" as const, label: "Case", count: 1, factorToBase: 0 }],
    // N2 (R-ui review, optional, 2026-09-21): a fractional factorToBase has no meaning.
    ["a fractional factor", { kind: "unit" as const, label: "Case", count: 1, factorToBase: 12.5 }],
    ["a negative factor", { kind: "unit" as const, label: "Case", count: 1, factorToBase: -12 }],
  ])("refuses %s", (_name, axis) => {
    expect(() => buildLine({ axis, unitPrice: 40 })).toThrow(AmbiguousLineError);
  });
});

/**
 * D-20 (#1808): the copier-contract registry (`apps/api/src/common/testing/copier-contract/`) can only
 * classify a copier that spreads `buildLine`'s result if the KEY SET of that result is fixed and known, and
 * `unitsPerBox` is the snapshot column the whole contract exists to protect (B644/B646/B647/B655/B665: a copy
 * that drops it re-prices a boxed line at the LIVE pack). Until now nothing pinned that `unitsPerBox` is ALWAYS
 * a key of a built line — on either axis, boxed or not. These pins are what a future
 * `SPREAD_HELPER_KEYS.buildLine` entry would stand on.
 */
describe("buildLine — the snapshot key contract (D-20)", () => {
  const KEYS = ["boxes", "pieces", "qty", "subtotal", "unitLabel", "unitPrice", "unitsPerBox"];
  const cases: [string, Parameters<typeof buildLine>[0]][] = [
    [
      "a boxed pack line",
      { axis: { kind: "pack", boxes: 6, pieces: 0, unitsPerBox: 12 }, unitPrice: 40 },
    ],
    [
      "an unboxed pack line",
      { axis: { kind: "pack", qty: 4, unitsPerBox: null }, unitPrice: 5.25 },
    ],
    [
      "a unit-axis line",
      { axis: { kind: "unit", label: "Case", count: 3, factorToBase: 12 }, unitPrice: 40 },
    ],
    [
      "a factor-1 unit line",
      { axis: { kind: "unit", label: "Piece", count: 5, factorToBase: 1 }, unitPrice: 4 },
    ],
  ];

  it.each(cases)("%s returns EXACTLY the fixed key set, with unitsPerBox present", (_n, input) => {
    expect(Object.keys(buildLine(input)).sort()).toEqual(KEYS);
  });

  it("unitsPerBox is the SNAPSHOT: the boxed pack, the unit factor (even 1), and null only when unboxed", () => {
    expect(buildLine(cases[0][1]).unitsPerBox).toBe(12);
    expect(buildLine(cases[1][1]).unitsPerBox).toBeNull();
    expect(buildLine(cases[2][1]).unitsPerBox).toBe(12);
    expect(buildLine(cases[3][1]).unitsPerBox).toBe(1); // a Piece off a boxed pack still snapshots its factor
  });
});
