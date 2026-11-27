import { computeLineSubtotal } from "./pricing";
import {
  editRowCount,
  editRowLimitLine,
  editRowMax,
  editRowUnit,
  seedEditRowUnit,
  setEditRowCount,
  type EditRow,
} from "./buyer-edit-line";
import { limitLine } from "./unit-line-count";

/**
 * REG-B1395 (SA-1292): the buyer edit-grid row rule. A stored 3-box line (12 a box, $18.00 a box) is the worked
 * example: "+" is one BOX (48 pieces, $72.00), never one piece (37, $55.50).
 */

/** A stored, named, box-split line: 3 boxes of 12 = 36 pieces. */
const BOX_ROW: EditRow = {
  orderItemId: "li-1",
  qty: 36,
  boxes: 3,
  pieces: 0,
  storedUnitsPerBox: 12,
  unitsPerBox: 12,
};

/** The money the grid shows for a split line at `qty` pieces (what buyerLineAmount asks computeLineSubtotal). */
const money = (qty: number) =>
  computeLineSubtotal({
    unitPrice: 18,
    qty,
    boxes: Math.floor(qty / 12),
    pieces: qty % 12,
    unitsPerBox: 12,
  });

describe("editRowUnit: the unit is decided from the stored row", () => {
  it("CASE: named, stored split, stored pack equals the live pack, qty a positive multiple of it", () => {
    expect(editRowUnit(BOX_ROW)).toBe("CASE");
  });

  it("CASE reads the pack from the line's own split when no snapshot was stored", () => {
    expect(editRowUnit({ ...BOX_ROW, storedUnitsPerBox: null })).toBe("CASE");
    expect(editRowUnit({ ...BOX_ROW, storedUnitsPerBox: undefined })).toBe("CASE");
  });

  it("PIECE: a row repacked since (stored 12, live 6)", () => {
    expect(editRowUnit({ ...BOX_ROW, unitsPerBox: 6 })).toBe("PIECE");
  });

  it("PIECE: loose pieces (3 boxes and 2 pieces = 38)", () => {
    expect(editRowUnit({ ...BOX_ROW, qty: 38, pieces: 2 })).toBe("PIECE");
  });

  it("PIECE: a split row whose live pack is gone, or whose own split cannot recover a pack", () => {
    expect(editRowUnit({ ...BOX_ROW, unitsPerBox: null })).toBe("PIECE");
    expect(editRowUnit({ ...BOX_ROW, storedUnitsPerBox: null, qty: 37, boxes: 3 })).toBe("PIECE");
  });

  it("PIECE: a split row with a non-positive or fractional qty", () => {
    expect(editRowUnit({ ...BOX_ROW, qty: 0 })).toBe("PIECE");
    expect(editRowUnit({ ...BOX_ROW, qty: 18 })).toBe("PIECE");
  });

  it("PACK: a named row stored in packs (no split)", () => {
    expect(editRowUnit({ orderItemId: "li-2", qty: 2, unitsPerBox: null })).toBe("PACK");
    expect(editRowUnit({ orderItemId: "li-2", qty: 2, unitsPerBox: 12 })).toBe("PACK");
  });

  it("PACK: every new row, whatever its product's pack", () => {
    expect(editRowUnit({ qty: 1 })).toBe("PACK");
    expect(editRowUnit({ qty: 1, unitsPerBox: 12 })).toBe("PACK");
    expect(editRowUnit({ orderItemId: null, qty: 1, unitsPerBox: 12 })).toBe("PACK");
  });

  it("a unit stored at seed is honoured, so typing never flips a row between boxes and pieces", () => {
    const seeded = { ...BOX_ROW, unit: seedEditRowUnit(BOX_ROW) };
    expect(seeded.unit).toBe("CASE");
    // the buyer steps to 37 pieces' worth by hand: a fresh decision would say PIECE, the seeded one holds
    expect(seedEditRowUnit({ ...seeded, qty: 37 })).toBe("PIECE");
    expect(editRowUnit({ ...seeded, qty: 37 })).toBe("CASE");
    expect(editRowUnit({ ...BOX_ROW, unit: "PIECE" })).toBe("PIECE");
  });
});

describe("editRowCount / setEditRowCount: the count is in the row's unit, the qty stays pieces", () => {
  it("CASE: 36 pieces count 3 boxes", () => {
    expect(editRowCount(BOX_ROW)).toBe(3);
  });

  it("CASE: a count of 4 is 48 PIECES, priced $72.00 (the red value was 37 pieces, $55.50)", () => {
    const qty = setEditRowCount(BOX_ROW, editRowCount(BOX_ROW) + 1);
    expect(qty).toBe(48);
    expect(money(qty)).toBe(72);
  });

  it("CASE: a typed 2 is 24 pieces, $36.00 (red: 2 pieces, $3.00); a typed 4 is 48, $72.00", () => {
    expect(setEditRowCount(BOX_ROW, 2)).toBe(24);
    expect(money(24)).toBe(36);
    expect(setEditRowCount(BOX_ROW, 4)).toBe(48);
  });

  it('CASE: "-" from 3 boxes is 24 pieces (red: 35)', () => {
    expect(setEditRowCount(BOX_ROW, editRowCount(BOX_ROW) - 1)).toBe(24);
  });

  it("PACK: the count is the qty, in packs", () => {
    const row: EditRow = { orderItemId: "li-2", qty: 2 };
    expect(editRowCount(row)).toBe(2);
    expect(setEditRowCount(row, 3)).toBe(3);
  });

  it("a new search row at 1, plus: 2", () => {
    const row: EditRow = { qty: 1, unitsPerBox: 12 };
    expect(setEditRowCount(row, editRowCount(row) + 1)).toBe(2);
  });

  it("PIECE: a repacked row (stored 12, live 6) at 36, plus: 37", () => {
    const row = { ...BOX_ROW, unitsPerBox: 6 };
    expect(editRowCount(row)).toBe(36);
    expect(setEditRowCount(row, 37)).toBe(37);
  });

  it("PIECE: a loose-piece row at 38, plus: 39", () => {
    const row = { ...BOX_ROW, qty: 38, pieces: 2 };
    expect(setEditRowCount(row, editRowCount(row) + 1)).toBe(39);
  });

  it("the save payload qty of a CASE row at 4 boxes is 48", () => {
    expect(setEditRowCount({ ...BOX_ROW, qty: 48, boxes: 4 }, 4)).toBe(48);
  });

  it("a count is whole and never below 0: 2.9 is 2, -3 and NaN are 0", () => {
    expect(setEditRowCount(BOX_ROW, 2.9)).toBe(24);
    expect(setEditRowCount(BOX_ROW, -3)).toBe(0);
    expect(setEditRowCount(BOX_ROW, Number.NaN)).toBe(0);
  });
});

describe("editRowMax: the bound is on the piece total", () => {
  it("CASE: 8,333 boxes at 12 a box (the red value was no bound at all)", () => {
    expect(editRowMax(BOX_ROW)).toBe(8333);
    expect(8333 * 12).toBeLessThanOrEqual(100_000);
    expect(8334 * 12).toBeGreaterThan(100_000);
  });

  it("PACK with a live pack above 1 counts packs inside the same bound", () => {
    expect(editRowMax({ qty: 1, unitsPerBox: 12 })).toBe(8333);
  });

  it("PACK with no pack, and PIECE, keep the plain cap", () => {
    expect(editRowMax({ qty: 1 })).toBe(100_000);
    expect(editRowMax({ qty: 1, unitsPerBox: 1 })).toBe(100_000);
    expect(editRowMax({ ...BOX_ROW, unitsPerBox: 6 })).toBe(100_000);
    expect(editRowMax({ ...BOX_ROW, qty: 38, pieces: 2 })).toBe(100_000);
  });

  it("a count past the bound clamps to it: 9,000 boxes is 8,333 boxes = 99,996 pieces", () => {
    expect(setEditRowCount(BOX_ROW, 9000)).toBe(99_996);
    expect(setEditRowCount(BOX_ROW, 8334)).toBe(99_996);
    expect(setEditRowCount(BOX_ROW, 8333)).toBe(99_996);
    expect(setEditRowCount({ qty: 1 }, 100_001)).toBe(100_000);
  });
});

describe("editRowLimitLine: the shared sentence, built per row", () => {
  it("a CASE row names its pack word in lower-case plural", () => {
    expect(editRowLimitLine(BOX_ROW, { unit: "each" })).toBe(
      "The most you can order at once is 8,333 boxes.",
    );
    expect(editRowLimitLine(BOX_ROW, { unit: "case" })).toBe(
      "The most you can order at once is 8,333 cases.",
    );
    expect(editRowLimitLine(BOX_ROW, { unit: "Case" })).toBe(
      "The most you can order at once is 8,333 cases.",
    );
  });

  it("a pack row with a live pack names the pack too", () => {
    expect(editRowLimitLine({ qty: 1, unitsPerBox: 12 }, { unit: "each" })).toBe(
      "The most you can order at once is 8,333 boxes.",
    );
  });

  it("a row counting pieces, or a plain row, ends at the number", () => {
    expect(editRowLimitLine({ ...BOX_ROW, unitsPerBox: 6 }, { unit: "each" })).toBe(
      "The most you can order at once is 100,000.",
    );
    expect(editRowLimitLine({ qty: 1 })).toBe("The most you can order at once is 100,000.");
  });

  it("limitLine is the one builder the cart shares", () => {
    expect(limitLine(8333, "cases")).toBe("The most you can order at once is 8,333 cases.");
    expect(limitLine(100_000)).toBe("The most you can order at once is 100,000.");
  });
});
