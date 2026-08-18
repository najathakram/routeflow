/**
 * `scan-line-units.ts` is the executable contract for BOTH the mobile
 * (`apps/mobile/lib/scan-line-units.ts`) and web (`apps/web/lib/scan-line-units.ts`)
 * mirrors — kept byte-identical. This pins the money invariant that guards
 * against the #335/#336 stock/AVCO corruption class: a Boxes line must
 * always carry `packSize` explicitly, a non-divisible piece count must never
 * be coerced into a fractional case, and converting between pieces/boxes
 * must never change the line's total money value.
 */
import { toBillLine, type PieceSnapshot } from "../lib/scan-line-units";
import { roundMoney } from "../lib/pricing";

describe("toBillLine — pieces", () => {
  it("returns the piece form with packSize explicitly null", () => {
    const snap: PieceSnapshot = { qtyPieces: 24, costPerPiece: 1.25 };
    expect(toBillLine(snap, "pieces", 24)).toEqual({
      qty: 24,
      unitCost: 1.25,
      packSize: null,
      converted: false,
    });
  });

  it("rounds unitCost to 4dp", () => {
    const snap: PieceSnapshot = { qtyPieces: 3, costPerPiece: 1.23456 };
    const line = toBillLine(snap, "pieces", null);
    expect(line.unitCost).toBe(1.2346);
    expect(line.packSize).toBeNull();
    expect("packSize" in line).toBe(true);
  });
});

describe("toBillLine — boxes (exact division)", () => {
  it("converts an exact case: qty/ppb, unitCost*ppb, packSize = ppb", () => {
    const snap: PieceSnapshot = { qtyPieces: 24, costPerPiece: 1.25 };
    expect(toBillLine(snap, "boxes", 24)).toEqual({
      qty: 1,
      unitCost: 30,
      packSize: 24,
      converted: true,
    });
  });

  it("packSize is ALWAYS present on a boxes conversion — the #335/#336 invariant", () => {
    const snap: PieceSnapshot = { qtyPieces: 48, costPerPiece: 0.5 };
    const line = toBillLine(snap, "boxes", 12);
    expect(line.packSize).toBe(12);
    expect("packSize" in line).toBe(true);
  });
});

describe("toBillLine — NOT_DIVISIBLE fallback", () => {
  it("25 pieces with ppb 24 stays in pieces with the warning and packSize null", () => {
    const snap: PieceSnapshot = { qtyPieces: 25, costPerPiece: 1.25 };
    expect(toBillLine(snap, "boxes", 24)).toEqual({
      qty: 25,
      unitCost: 1.25,
      packSize: null,
      converted: false,
      warning: "NOT_DIVISIBLE",
    });
  });

  it("never emits a fractional case count", () => {
    const snap: PieceSnapshot = { qtyPieces: 10, costPerPiece: 3 };
    const line = toBillLine(snap, "boxes", 24);
    expect(Number.isInteger(line.qty)).toBe(true);
    expect(line.warning).toBe("NOT_DIVISIBLE");
    expect(line.packSize).toBeNull();
  });

  it("falls back when piecesPerBox is missing, non-integer, or below 2", () => {
    const snap: PieceSnapshot = { qtyPieces: 24, costPerPiece: 1.25 };
    expect(toBillLine(snap, "boxes", null).warning).toBe("NOT_DIVISIBLE");
    expect(toBillLine(snap, "boxes", undefined).warning).toBe("NOT_DIVISIBLE");
    expect(toBillLine(snap, "boxes", 1).warning).toBe("NOT_DIVISIBLE");
    expect(toBillLine(snap, "boxes", 12.5).warning).toBe("NOT_DIVISIBLE");
  });
});

describe("toBillLine — PPB_MISMATCH", () => {
  it("warns when the catalog ppb differs, but the on-screen ppb wins the saved value", () => {
    const snap: PieceSnapshot = { qtyPieces: 24, costPerPiece: 1.25 };
    const line = toBillLine(snap, "boxes", 24, 12);
    expect(line.warning).toBe("PPB_MISMATCH");
    expect(line.packSize).toBe(24);
    expect(line.qty).toBe(1);
  });

  it("no warning when the catalog ppb matches the on-screen ppb", () => {
    const snap: PieceSnapshot = { qtyPieces: 24, costPerPiece: 1.25 };
    expect(toBillLine(snap, "boxes", 24, 24).warning).toBeUndefined();
  });

  it("no PPB_MISMATCH check runs when the catalog gave nothing", () => {
    const snap: PieceSnapshot = { qtyPieces: 24, costPerPiece: 1.25 };
    expect(toBillLine(snap, "boxes", 24, null).warning).toBeUndefined();
  });
});

describe("toBillLine — money invariant", () => {
  it("roundMoney(qty x unitCost) is identical across pieces and boxes representations", () => {
    const snap: PieceSnapshot = { qtyPieces: 24, costPerPiece: 1.25 };
    const pieces = toBillLine(snap, "pieces", 24);
    const boxes = toBillLine(snap, "boxes", 24);
    expect(roundMoney(pieces.qty * pieces.unitCost)).toBe(roundMoney(boxes.qty * boxes.unitCost));
  });

  it("holds for a non-round per-piece cost", () => {
    const snap: PieceSnapshot = { qtyPieces: 36, costPerPiece: 0.8333 };
    const pieces = toBillLine(snap, "pieces", 12);
    const boxes = toBillLine(snap, "boxes", 12);
    expect(roundMoney(pieces.qty * pieces.unitCost)).toBe(roundMoney(boxes.qty * boxes.unitCost));
  });
});

describe("toBillLine — round-trip", () => {
  it("pieces -> boxes -> pieces restores the snapshot exactly", () => {
    const snap: PieceSnapshot = { qtyPieces: 24, costPerPiece: 1.25 };
    const boxes = toBillLine(snap, "boxes", 24);
    const restored: PieceSnapshot = {
      qtyPieces: boxes.qty * (boxes.packSize as number),
      costPerPiece: boxes.unitCost / (boxes.packSize as number),
    };
    const pieces = toBillLine(restored, "pieces", 24);
    expect(pieces.qty).toBe(snap.qtyPieces);
    expect(pieces.unitCost).toBe(snap.costPerPiece);
  });

  it("round-trips a non-trivial ppb without precision drift", () => {
    const snap: PieceSnapshot = { qtyPieces: 144, costPerPiece: 2.0833 };
    const boxes = toBillLine(snap, "boxes", 12);
    expect(boxes.warning).toBeUndefined();
    const restored: PieceSnapshot = {
      qtyPieces: boxes.qty * (boxes.packSize as number),
      costPerPiece: boxes.unitCost / (boxes.packSize as number),
    };
    const pieces = toBillLine(restored, "pieces", 12);
    expect(pieces.qty).toBe(snap.qtyPieces);
    expect(pieces.unitCost).toBe(snap.costPerPiece);
  });
});
