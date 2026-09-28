/**
 * #2698 — mobile parity with #2696(d), the owner's one-unit-sold rule: a Case line sells ONE unit
 * level. The loose-units stepper is opt-in behind a small "+ units" control, never shown by
 * default; a line that already carries pieces opens with it shown; removing it sets pieces to 0
 * EXPLICITLY. The payload shape is unchanged ({qty, boxes, pieces} through lib/sale-line).
 * CartRow.tsx can't render under the mobile Jest env (pure-logic/node), so its wiring is a
 * source-text pin, as line-note-copy.pins.test.ts does.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { looseUnitsVisible } from "../lib/loose-units";
import { setLineBoxes, setLinePieces } from "../lib/sale-line";

describe("#2698 looseUnitsVisible — the show rule", () => {
  it("hidden by default (not opened, no pieces)", () => {
    expect(looseUnitsVisible(false, 0)).toBe(false);
    expect(looseUnitsVisible(false, null)).toBe(false);
  });
  it("shown once '+ units' is tapped", () => {
    expect(looseUnitsVisible(true, 0)).toBe(true);
  });
  it("shown for a line that already carries pieces (editing boxes + pieces)", () => {
    expect(looseUnitsVisible(false, 3)).toBe(true);
  });
});

describe("#2698 the payload is unchanged", () => {
  const fresh = { qty: 0, boxes: 0, pieces: 0 };

  it("default Case entry submits pieces = 0", () => {
    expect(setLineBoxes(fresh, 2, 24)).toMatchObject({ qty: 48, boxes: 2, pieces: 0 });
  });

  it("'+ units' then loose pieces flow into the same {qty, boxes, pieces}", () => {
    const cases = setLineBoxes(fresh, 2, 24)!;
    expect(setLinePieces(cases, 5, 24)).toMatchObject({ qty: 53, boxes: 2, pieces: 5 });
  });

  it("'Remove extra units' sets pieces to 0 explicitly and keeps the cases", () => {
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

  it("a '+ units' control opens it", () => {
    expect(src).toMatch(/>\s*\+ units\s*</);
    expect(src).toMatch(/setLooseUnitsOpen\(true\)/);
  });

  it("the open stepper is 'Extra loose units' (max upb − 1) with a 'Remove extra units' control", () => {
    expect(src).toMatch(/Extra loose units/);
    expect(src).toMatch(/max=\{upb - 1\}/);
    expect(src).toMatch(/accessibilityLabel="Remove extra units"/);
    expect(src).toMatch(/onChangePieces\(0\)/);
  });
});
