import {
  decrementLine,
  incrementLine,
  incrementLinePiece,
  isUnitLine,
  setLineBoxes,
  setLinePieces,
  setLineQty,
  setLineUnits,
  stepLineQty,
} from "../lib/sale-line";

describe("incrementLine", () => {
  it("increments a plain line and PRESERVES unitPrice/note/noteOpen (repeat-scan field wipe fix)", () => {
    const prev = { qty: 2, unitPrice: 9.5, note: "chilled", noteOpen: true };
    const next = incrementLine(prev, false, 0);
    expect(next.qty).toBe(3);
    expect(next.unitPrice).toBe(9.5);
    expect(next.note).toBe("chilled");
    expect(next.noteOpen).toBe(true);
  });

  it("increments a boxed line by one BOX and preserves fields", () => {
    const prev = { qty: 12, boxes: 1, pieces: 0, unitPrice: 20, note: "n" };
    const next = incrementLine(prev, true, 12);
    expect(next.boxes).toBe(2);
    expect(next.pieces).toBe(0);
    expect(next.qty).toBe(24);
    expect(next.unitPrice).toBe(20);
    expect(next.note).toBe("n");
  });

  it("keeps loose pieces when adding a box", () => {
    const next = incrementLine({ qty: 15, boxes: 1, pieces: 3 }, true, 12);
    expect(next.boxes).toBe(2);
    expect(next.pieces).toBe(3);
    expect(next.qty).toBe(27); // 2*12 + 3
  });

  it("starts a new line from a zero default", () => {
    expect(incrementLine({ qty: 0 }, false, 0).qty).toBe(1);
    const boxed = incrementLine({ qty: 0 }, true, 6);
    expect(boxed.boxes).toBe(1);
    expect(boxed.qty).toBe(6);
  });

  it("a second increment compounds on the first (repeat scans stack)", () => {
    let line: { qty?: number; unitPrice?: number } = { qty: 0, unitPrice: 7 };
    line = incrementLine(line, false, 0);
    line = incrementLine(line, false, 0);
    line = incrementLine(line, false, 0);
    expect(line.qty).toBe(3);
    expect(line.unitPrice).toBe(7); // survived every increment
  });
});

describe("decrementLine", () => {
  it("decrements a loose line and preserves unitPrice/note/noteOpen", () => {
    const prev = { qty: 3, unitPrice: 9.5, note: "chilled", noteOpen: true };
    const next = decrementLine(prev, false, 0);
    expect(next).not.toBeNull();
    expect(next!.qty).toBe(2);
    expect(next!.unitPrice).toBe(9.5);
    expect(next!.note).toBe("chilled");
    expect(next!.noteOpen).toBe(true);
  });

  it("returns null when a loose line at qty 1 is decremented to 0", () => {
    const prev = { qty: 1, unitPrice: 5 };
    expect(decrementLine(prev, false, 0)).toBeNull();
  });

  it("removes one box from a boxed line, keeping loose pieces and other fields", () => {
    const prev = { qty: 27, boxes: 2, pieces: 3, unitPrice: 20, note: "n" };
    const next = decrementLine(prev, true, 12);
    expect(next).not.toBeNull();
    expect(next!.boxes).toBe(1);
    expect(next!.pieces).toBe(3);
    expect(next!.qty).toBe(15); // 1*12 + 3
    expect(next!.unitPrice).toBe(20);
    expect(next!.note).toBe("n");
  });

  it("returns null for a boxed line already at 0 boxes + 0 pieces", () => {
    const prev = { qty: 0, boxes: 0, pieces: 0 };
    expect(decrementLine(prev, true, 12)).toBeNull();
  });

  it("returns null when a boxed line with 1 box and 0 pieces is decremented", () => {
    const prev = { qty: 12, boxes: 1, pieces: 0 };
    expect(decrementLine(prev, true, 12)).toBeNull();
  });
});

describe("setLineQty", () => {
  it("sets qty and preserves unitPrice/note", () => {
    const prev = { qty: 1, unitPrice: 9.5, note: "chilled" };
    const next = setLineQty(prev, 5);
    expect(next).not.toBeNull();
    expect(next!.qty).toBe(5);
    expect(next!.unitPrice).toBe(9.5);
    expect(next!.note).toBe("chilled");
  });

  it("clears boxes/pieces on set (server should not recompute from stale box split)", () => {
    const prev = { qty: 27, boxes: 2, pieces: 3, unitPrice: 20 };
    const next = setLineQty(prev, 5);
    expect(next).not.toBeNull();
    expect("boxes" in next!).toBe(false);
    expect("pieces" in next!).toBe(false);
    expect(next!.qty).toBe(5);
    expect(next!.unitPrice).toBe(20);
  });

  it("returns null when qty is set to 0", () => {
    const prev = { qty: 5, unitPrice: 9.5 };
    expect(setLineQty(prev, 0)).toBeNull();
  });

  it("floors a fractional qty", () => {
    const prev = { qty: 1 };
    const next = setLineQty(prev, 4.9);
    expect(next).not.toBeNull();
    expect(next!.qty).toBe(4);
  });

  it("returns null for a negative qty", () => {
    const prev = { qty: 5 };
    expect(setLineQty(prev, -3)).toBeNull();
  });
});

describe("setLineBoxes", () => {
  it("sets boxes, recomputes qty, and preserves pieces + other fields", () => {
    const prev = { qty: 15, boxes: 1, pieces: 3, unitPrice: 20, note: "n" };
    const next = setLineBoxes(prev, 2, 12);
    expect(next).not.toBeNull();
    expect(next!.boxes).toBe(2);
    expect(next!.pieces).toBe(3);
    expect(next!.qty).toBe(27); // 2*12 + 3
    expect(next!.unitPrice).toBe(20);
    expect(next!.note).toBe("n");
  });

  it("keeps loose pieces when boxes change", () => {
    const prev = { qty: 3, boxes: 0, pieces: 3 };
    const next = setLineBoxes(prev, 1, 12);
    expect(next).not.toBeNull();
    expect(next!.pieces).toBe(3);
    expect(next!.qty).toBe(15);
  });

  it("returns null when boxes and pieces both resolve to 0", () => {
    const prev = { qty: 12, boxes: 1, pieces: 0 };
    expect(setLineBoxes(prev, 0, 12)).toBeNull();
  });

  it("SA-085h MEDIUM: REFUSES a split on a unit-sold line, returning it unchanged", () => {
    const prev = { qty: 2, unitLabel: "Case", unitPrice: 220 };
    expect(setLineBoxes(prev, 5, 24)).toEqual(prev);
  });
});

describe("setLinePieces", () => {
  it("sets pieces, recomputes qty, and preserves boxes + other fields", () => {
    const prev = { qty: 12, boxes: 1, pieces: 0, unitPrice: 20, note: "n" };
    const next = setLinePieces(prev, 5, 12);
    expect(next).not.toBeNull();
    expect(next!.pieces).toBe(5);
    expect(next!.boxes).toBe(1);
    expect(next!.qty).toBe(17); // 1*12 + 5
    expect(next!.unitPrice).toBe(20);
    expect(next!.note).toBe("n");
  });

  it("returns null when boxes and pieces both resolve to 0", () => {
    const prev = { qty: 0, boxes: 0, pieces: 0 };
    expect(setLinePieces(prev, 0, 12)).toBeNull();
  });

  it("SA-085h MEDIUM: REFUSES a split on a unit-sold line, returning it unchanged", () => {
    const prev = { qty: 2, unitLabel: "Case", unitPrice: 220 };
    expect(setLinePieces(prev, 5, 24)).toEqual(prev);
  });
});

describe("setLineUnits", () => {
  it("normalizes a total unit count into cases + loose units, preserving other fields", () => {
    const prev = { qty: 6, boxes: 1, pieces: 0, unitPrice: 30, note: "x" };
    const next = setLineUnits(prev, 7, 6);
    expect(next).not.toBeNull();
    expect(next!.qty).toBe(7);
    expect(next!.boxes).toBe(1);
    expect(next!.pieces).toBe(1);
    expect(next!.unitPrice).toBe(30);
    expect(next!.note).toBe("x");
  });

  it("returns null when the unit count resolves to 0", () => {
    const prev = { qty: 6, boxes: 1, pieces: 0, unitPrice: 30, note: "x" };
    expect(setLineUnits(prev, 0, 6)).toBeNull();
  });

  it("normalizes an exact multiple of the case size to 0 loose units", () => {
    const prev = { qty: 6, boxes: 1, pieces: 0, unitPrice: 30, note: "x" };
    const next = setLineUnits(prev, 12, 6);
    expect(next).not.toBeNull();
    expect(next!.qty).toBe(12);
    expect(next!.boxes).toBe(2);
    expect(next!.pieces).toBe(0);
  });

  it("returns null for a non-case-packed product (unitsPerBox 1)", () => {
    const prev = { qty: 1 };
    expect(setLineUnits(prev, 5, 1)).toBeNull();
  });

  it("SA-085h MEDIUM: on a unit-sold line, the typed total IS the new count — setQty, never a split", () => {
    const prev = { qty: 1, unitLabel: "Case", unitPrice: 220 };
    const next = setLineUnits(prev, 3, 24);
    expect(next).toEqual({
      qty: 3,
      unitLabel: "Case",
      unitPrice: 220,
      boxes: undefined,
      pieces: undefined,
    });
  });

  it("SA-085h: a unit-sold line resolving to 0 is removed, same as setQty", () => {
    const prev = { qty: 1, unitLabel: "Case", unitPrice: 220 };
    expect(setLineUnits(prev, 0, 24)).toBeNull();
  });
});

/**
 * SA-085f BLOCKER: qty gained a second meaning once `unitLabel` is set — a Case line's
 * qty is the unit COUNT, never pieces-in-a-box. Every +/- writer on both sale builders
 * must route through `stepLineQty` instead of incrementLine/decrementLine directly.
 */
describe("isUnitLine / stepLineQty (SA-085f BLOCKER)", () => {
  it("isUnitLine is true only for a non-empty unitLabel", () => {
    expect(isUnitLine({ unitLabel: "Case" })).toBe(true);
    expect(isUnitLine({ unitLabel: undefined })).toBe(false);
    expect(isUnitLine({ unitLabel: null })).toBe(false);
    expect(isUnitLine({ unitLabel: "" })).toBe(false);
    expect(isUnitLine({})).toBe(false);
  });

  it("+ on a Case line ({qty:1}, 24-pack) steps the COUNT to 2 — no box/piece split", () => {
    const prev = { qty: 1, unitLabel: "Case", unitPrice: 220, unitBasePrice: 220 };
    const next = stepLineQty(prev, 1, true, 24);
    expect(next).toEqual({ qty: 2, unitLabel: "Case", unitPrice: 220, unitBasePrice: 220 });
  });

  it("RED PROOF: the old unconditional incrementLine reconstructs the shipped bug on the same line", () => {
    // The exact worked example: a Case line on a 24-pack, tapped +, priced at $220/case.
    // The fix's own line (above) reads {qty:2, ...}; the OLD call this replaced —
    // incrementLine(prev, isBoxed, upb) with no unitLabel check — read {qty:25,...}
    // and would bill 25 x $220 = $5,500 for what the screen showed as $229.17.
    const prev = { qty: 1, unitLabel: "Case", unitPrice: 220, unitBasePrice: 220 };
    const oldBuggyNext = incrementLine(prev, true, 24);
    expect(oldBuggyNext.qty).toBe(25);
    expect(oldBuggyNext.boxes).toBe(1);
    expect(oldBuggyNext.pieces).toBe(1);
    expect(oldBuggyNext.qty).not.toBe(2); // the fixed behaviour, proven above
  });

  it("- on a Case line ({qty:3}) steps the COUNT down to 2", () => {
    const prev = { qty: 3, unitLabel: "Case", unitPrice: 220 };
    const next = stepLineQty(prev, -1, true, 24);
    expect(next).toEqual({ qty: 2, unitLabel: "Case", unitPrice: 220 });
  });

  it("- on a Case line at count 1 removes the line (returns null), never a fractional box", () => {
    const prev = { qty: 1, unitLabel: "Case", unitPrice: 220 };
    expect(stepLineQty(prev, -1, true, 24)).toBeNull();
  });

  it("a non-unit line falls through to the existing pack box-math unchanged", () => {
    const prev = { qty: 12, boxes: 1, pieces: 0, unitPrice: 20 };
    expect(stepLineQty(prev, 1, true, 12)).toEqual(incrementLine(prev, true, 12));
    expect(stepLineQty(prev, -1, true, 12)).toEqual(decrementLine(prev, true, 12));
  });

  it("a non-boxed, non-unit line steps by plain +/-1", () => {
    expect(stepLineQty({ qty: 4 }, 1, false, 0)).toEqual({ qty: 5 });
    expect(stepLineQty({ qty: 4 }, -1, false, 0)).toEqual({ qty: 3 });
  });
});

describe("incrementLinePiece (piece-barcode scan)", () => {
  it("adds one loose piece to a boxed line, preserving fields", () => {
    const line = incrementLinePiece(
      { qty: 6, boxes: 1, pieces: 0, unitPrice: 9, note: "n" },
      true,
      6,
    );
    expect(line).toEqual({ qty: 7, boxes: 1, pieces: 1, unitPrice: 9, note: "n" });
  });
  it("rolls loose pieces into a box at unitsPerBox", () => {
    const line = incrementLinePiece({ qty: 11, boxes: 1, pieces: 5 }, true, 6);
    expect(line).toEqual({ qty: 12, boxes: 2, pieces: 0 });
  });
  it("starts a fresh boxed line at 0 boxes + 1 loose", () => {
    expect(incrementLinePiece({ qty: 0 }, true, 6)).toEqual({ qty: 1, boxes: 0, pieces: 1 });
  });
  it("non-boxed: a piece IS the unit", () => {
    expect(incrementLinePiece({ qty: 2, unitPrice: 3 } as any, false, 0)).toEqual({
      qty: 3,
      unitPrice: 3,
    });
  });
});
