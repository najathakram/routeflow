/**
 * #2698 — mobile parity with #2696(d), the owner's one-unit-sold rule: a Case line sells ONE unit
 * level. The loose-units stepper is opt-in behind a small "+ pieces" control, never shown by
 * default; a line that already carries pieces opens with it shown; removing it sets pieces to 0
 * EXPLICITLY. The payload shape is unchanged ({qty, boxes, pieces} through lib/sale-line).
 * CartRow.tsx can't render under the mobile Jest env (pure-logic/node), so its wiring is a
 * source-text pin, as line-note-copy.pins.test.ts does.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { canRemoveLooseUnits, looseUnitsVisible } from "../lib/loose-units";
import { setLineBoxes, setLinePieces } from "../lib/sale-line";

describe("#2698 looseUnitsVisible — the show rule", () => {
  it("hidden by default (not opened, no pieces)", () => {
    expect(looseUnitsVisible(false, 0)).toBe(false);
    expect(looseUnitsVisible(false, null)).toBe(false);
  });
  it("shown once '+ pieces' is tapped", () => {
    expect(looseUnitsVisible(true, 0)).toBe(true);
  });
  it("shown for a line that already carries pieces (editing boxes + pieces)", () => {
    expect(looseUnitsVisible(false, 3)).toBe(true);
  });
});

// SA-563 (identical to web #2699(d)): with 0 cases the loose units ARE the line, so "Remove extra
// units" is hidden (not disabled, no invented case, no dialog); remove-line is the only way to
// remove a line.
describe("#2698 SA-563 'Remove extra pieces' only when there are cases", () => {
  it("0 cases + n units ⇒ the control is absent", () => {
    expect(canRemoveLooseUnits(0)).toBe(false);
    expect(canRemoveLooseUnits(null)).toBe(false);
  });
  it("≥ 1 case + n units ⇒ present", () => {
    expect(canRemoveLooseUnits(1)).toBe(true);
    expect(canRemoveLooseUnits(3)).toBe(true);
  });
  it("tapping it (cases ≥ 1) takes the units to 0, keeps the cases and the line", () => {
    const line = setLinePieces(setLineBoxes({ qty: 0, boxes: 0, pieces: 0 }, 1, 24)!, 5, 24)!;
    const after = setLinePieces(line, 0, 24);
    expect(after).not.toBeNull();
    expect(after).toMatchObject({ qty: 24, boxes: 1, pieces: 0 });
  });
  it("CartRow renders the control only behind canRemoveLooseUnits(line.boxes)", () => {
    const src = readFileSync(join(__dirname, "..", "components", "CartRow.tsx"), "utf8");
    expect(src).toMatch(/canRemoveLooseUnits\(\s*line\.boxes\s*\)\s*\?/);
  });
});

describe("#2698 the payload is unchanged", () => {
  const fresh = { qty: 0, boxes: 0, pieces: 0 };

  it("default Case entry submits pieces = 0", () => {
    expect(setLineBoxes(fresh, 2, 24)).toMatchObject({ qty: 48, boxes: 2, pieces: 0 });
  });

  it("'+ pieces' then loose pieces flow into the same {qty, boxes, pieces}", () => {
    const cases = setLineBoxes(fresh, 2, 24)!;
    expect(setLinePieces(cases, 5, 24)).toMatchObject({ qty: 53, boxes: 2, pieces: 5 });
  });

  it("'Remove extra pieces' sets pieces to 0 explicitly and keeps the cases", () => {
    const withLoose = setLinePieces(setLineBoxes(fresh, 2, 24)!, 5, 24)!;
    expect(setLinePieces(withLoose, 0, 24)).toMatchObject({ qty: 48, boxes: 2, pieces: 0 });
  });
});

describe("#2698 CartRow wiring (source pin)", () => {
  const src = readFileSync(join(__dirname, "..", "components", "CartRow.tsx"), "utf8");

  it("the loose stepper renders only when looseUnitsVisible(open, pieces)", () => {
    expect(src).toMatch(/useState\(false\)/);
    expect(src).toMatch(/looseUnitsVisible\(\s*looseUnitsOpen,\s*line\.pieces\s*\)/);
  });

  it("a '+ pieces' control opens it", () => {
    expect(src).toMatch(/>\s*\+ pieces\s*</);
    expect(src).toMatch(/setLooseUnitsOpen\(true\)/);
  });

  it("the open stepper is 'Extra pieces' (max upb − 1) with a 'Remove extra pieces' control", () => {
    expect(src).toMatch(/Extra pieces/);
    expect(src).toMatch(/max=\{upb - 1\}/);
    expect(src).toMatch(/accessibilityLabel="Remove extra pieces"/);
    expect(src).toMatch(/onChangePieces\(0\)/);
  });
});
