import { hasUnitLine, isUnitLine, unitLabelsOf } from "../lib/invoice-line-unit";

/**
 * B784 — mirrors apps/web/lib/invoice-line-unit.test.ts's own cases for this exact
 * logic, duplicated on mobile (RN can't import a web module).
 */
describe("isUnitLine / hasUnitLine / unitLabelsOf", () => {
  it("only a non-blank unitLabel makes a unit line", () => {
    expect(isUnitLine({ unitLabel: "Case" })).toBe(true);
    for (const u of [undefined, null, "", "  "]) expect(isUnitLine({ unitLabel: u })).toBe(false);
    expect(isUnitLine(null)).toBe(false);
  });

  it("an invoice holds a unit line when ANY line does (and an empty/missing list does not)", () => {
    expect(hasUnitLine([{ unitLabel: null }, { unitLabel: "Case" }])).toBe(true);
    expect(hasUnitLine([{ unitLabel: null }, {}])).toBe(false);
    expect(hasUnitLine([])).toBe(false);
    expect(hasUnitLine(undefined)).toBe(false);
  });

  it("lists each distinct unit once, in line order", () => {
    expect(
      unitLabelsOf([
        { unitLabel: "Case" },
        { unitLabel: null },
        { unitLabel: "Pallet" },
        { unitLabel: "Case " },
      ]),
    ).toEqual(["Case", "Pallet"]);
    expect(unitLabelsOf(undefined)).toEqual([]);
  });
});
