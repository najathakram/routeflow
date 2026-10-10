import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-085f BLOCKER. Every qty writer on both sale builders must route a unit-sold line
 * (unitLabel set) through `stepLineQty`/`isUnitLine` (lib/sale-line.ts) instead of the
 * pack's box math (incrementLine/decrementLine, which fold a unit COUNT into "boxes" of the
 * PACK's size — see sale-line.test.ts's RED PROOF for the exact shipped-bug numbers). Mobile's
 * Jest is pure-logic only (no RN tree), so each screen's wiring is pinned at the source level,
 * the same technique wedge-submit.test.ts and order-draft-gate.test.ts already use.
 */

const newOrderSrc = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");
const editItemsSrc = readFileSync(
  join(__dirname, "..", "app", "(operator)", "(tabs)", "orders", "[id]", "edit-items.tsx"),
  "utf8",
);
// B775/SA-108: a re-scan's merge-into-existing-entry transform (applyPickToDraft)
// moved out of this screen into the pure lib, so its unit-guard is pinned there.
const adapterSrc = readFileSync(join(__dirname, "..", "lib", "pending-unit-adapter.ts"), "utf8"); // #2865: the add moved here
const editItemsDraftSrc = readFileSync(join(__dirname, "..", "lib", "edit-items-draft.ts"), "utf8");

describe("NewOrderScreen.tsx routes every +/- through stepLineQty (create flow)", () => {
  it("addOne/removeOne route through the unit-aware writers, never the raw pack box math", () => {
    // addOne goes through addScannedLevelToLine (SA-580: the scanned level decides), which itself
    // steps a unit line's COUNT — pinned in the next test.
    expect(adapterSrc).toMatch(
      /addScannedLevelToLine\(cur \?\? \{ qty: 0 \}, a\.level, a\.upb > 1, a\.upb\)/,
    );
    expect(newOrderSrc).toMatch(/stepLineQty\(prev, -1, upbNum\(id\) > 1, upbNum\(id\)\)/);
    // incrementLine/decrementLine are no longer imported or called directly anywhere in this
    // screen — every case a unit-aware line could reach them is gone, not just guarded.
    expect(newOrderSrc).not.toMatch(/[^.]\bincrementLine\(/);
    expect(newOrderSrc).not.toMatch(/\bdecrementLine\(/);
  });

  it("a scan's level goes through addScannedLevelToLine, which steps a unit line's COUNT (never box math)", () => {
    expect(adapterSrc).toMatch(
      /addScannedLevelToLine\(cur \?\? \{ qty: 0 \}, a\.level, a\.upb > 1, a\.upb\)/,
    );
    const src = readFileSync(join(__dirname, "..", "lib", "sale-line.ts"), "utf8");
    const body = src.slice(
      src.indexOf("export function addScannedLevelToLine"),
      src.indexOf("export function decrementLine"),
    );
    // SA-085f one qty step: the unit-line/BOX branch IS stepLineQty(+1), never re-implemented inline.
    expect(body).toMatch(/stepLineQty\(prev, 1, isBoxed, unitsPerBox\)/);
    expect(body).not.toMatch(/\(prev\.qty \?\? 0\) \+ 1/);
    expect(body).not.toMatch(/incrementLine\(/);
  });

  it("the tray sends a unit line's typed total through setQty, never setUnits", () => {
    expect(newOrderSrc).toMatch(/!a\.isUnitLine\(id\) && a\.unitsPerBox\(id\) > 1/);
  });
});

describe("edit-items.tsx routes every +/- through unit-aware helpers (edit flow)", () => {
  it("incQty/decQty step a unit line's COUNT via setQty, never setBoxes's box math (SA-085i(c))", () => {
    expect(editItemsSrc).toMatch(
      /if \(cur\.unitLabel\) return setQty\(id, \(cur\.qty \?\? 0\) \+ 1\)/,
    );
    expect(editItemsSrc).toMatch(
      /if \(cur\.unitLabel\) return setQty\(id, Math\.max\(0, \(cur\.qty \?\? 0\) - 1\)\)/,
    );
  });

  it("setBoxes/setPieces route through applyBoxEdit/applyPieceEdit, which refuse a unit-line split AND match master's non-unit math byte-for-byte", () => {
    expect(editItemsSrc).toMatch(/applyBoxEdit\(cur, boxes, Number\(cur\.unitsPerBox \?\? 0\)\)/);
    expect(editItemsSrc).toMatch(
      /applyPieceEdit\(cur, pieces, Number\(cur\.unitsPerBox \?\? 0\)\)/,
    );
  });

  it("a re-scan's incrementLine/incrementLinePiece call is unit-guarded (lib/edit-items-draft.ts#applyPickToDraft)", () => {
    expect(editItemsDraftSrc).toMatch(/if \(boxed && !isUnitLine\(existing\)\)/);
  });

  it("the drawer sends a unit line's typed total through setQty, never setUnits", () => {
    expect(editItemsSrc).toMatch(/isUnitLine\(d\.draft\[id\] \?\? \{\}\)/);
  });

  it("a piece-code scan on an already unit-sold line confirms before committing (SA-085i)", () => {
    expect(editItemsSrc).toMatch(/level === "UNIT" && existingLabel/);
    expect(editItemsSrc).toMatch(/confirm\(/);
  });
});
