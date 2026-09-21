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
    ["a zero factor", { kind: "unit" as const, label: "Case", count: 1, factorToBase: 0 }],
    ["a negative factor", { kind: "unit" as const, label: "Case", count: 1, factorToBase: -12 }],
  ])("refuses %s", (_name, axis) => {
    expect(() => buildLine({ axis, unitPrice: 40 })).toThrow(AmbiguousLineError);
  });
});
