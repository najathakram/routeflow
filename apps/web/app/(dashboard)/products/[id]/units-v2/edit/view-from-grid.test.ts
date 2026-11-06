import { priceGrid, type FamilyCell, type LadderView } from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { familyCellsFromGrid, previewRows, rulesFromGrid, viewFromGrid } from "./view-from-grid";

const view: LadderView = {
  rows: [
    { ref: "pack", label: "Case", factor: 24, kind: "pack", set: [24, 22, null, null, null] },
    { ref: "u1", label: "Box", factor: 12, kind: "unit", set: [12.5, null, null, null, null] },
    { ref: "base", label: "Piece", factor: 1, kind: "base", set: [null, null, null, null, null] },
  ],
  anchor: "pack",
  tierAnchors: { 3: "u1" },
};
const rules = { 2: 5, 3: 10 };

const dto = (v: LadderView): ProductPriceGridDto => ({
  productId: "p1",
  anchor: v.anchor,
  revision: 3,
  priceState: "state-3",
  tierAnchors: v.tierAnchors,
  tierRules: rules,
  rows: priceGrid(v, rules).map((r) => ({ ...r, code: null, editable: true })),
});

describe("viewFromGrid", () => {
  it("round-trips: priceGrid(viewFromGrid(dto)) equals the DTO cells", () => {
    const g = dto(view);
    const back = viewFromGrid(g);
    expect(priceGrid(back, rulesFromGrid(g))).toEqual(
      g.rows.map(({ code: _code, editable: _editable, ...row }) => row),
    );
    expect(back.tierAnchors).toEqual({ 3: "u1" });
  });

  it("a grid with no tier anchors or rules is the plain ladder", () => {
    const g = { ...dto(view), tierAnchors: {}, tierRules: {} };
    expect(viewFromGrid(g).tierAnchors).toEqual({});
    expect(rulesFromGrid(g)).toEqual({});
  });

  it("previewRows keeps each row's barcode", () => {
    const g = dto(view);
    g.rows[0].code = "0123";
    expect(previewRows(viewFromGrid(g), rulesFromGrid(g), g)[0].code).toBe("0123");
  });
});

describe("SA-1082 ruling 5: the word follows the draft", () => {
  const ladder: LadderView = {
    rows: [{ ref: "pack", label: "Case", factor: 12, kind: "pack", set: [24, 22, null, 18, null] }],
    anchor: "pack",
    tierAnchors: {},
  };
  const withFamily = (cells: FamilyCell[]): ProductPriceGridDto => {
    const g = dto(ladder);
    return {
      ...g,
      rows: g.rows.map((r) => ({
        ...r,
        cells: r.cells.map((c) => ({ ...c, family: cells[c.tier - 1] })),
      })),
    };
  };
  const served = withFamily([
    { value: 24, follows: true },
    { value: 22, follows: true },
    { value: null, follows: true },
    { value: 18, follows: false },
    { value: null, follows: true },
  ]);
  const followsIn = (set: (number | null)[]) =>
    previewRows({ ...ladder, rows: [{ ...ladder.rows[0]!, set }] }, rules, served)[0]?.cells.map(
      (c) => c.family?.follows,
    );

  it("reads the five cells the server served, and only when all five are there", () => {
    expect(familyCellsFromGrid(served)?.map((c) => c.value)).toEqual([24, 22, null, 18, null]);
    expect(familyCellsFromGrid(dto(ladder))).toBeNull();
  });

  it("an untouched draft keeps the server's answer, whatever a blank tier's rule shows", () => {
    expect(followsIn([24, 22, null, 18, null])).toEqual([true, true, true, true, true]);
  });

  it("a Retail away from the family's takes every word with it", () => {
    expect(followsIn([30, null, null, null, null])).toEqual([false, false, false, false, false]);
  });

  it("a Retail back at the family's price reads Family again", () => {
    expect(followsIn([24, 22, null, 18, null])?.[0]).toBe(true);
  });

  it("a tier typed away from the family's stops following; its neighbours don't", () => {
    expect(followsIn([24, 21, null, 18, null])?.slice(0, 2)).toEqual([true, false]);
  });

  it("a grid with no family gets no family on its cells", () => {
    expect(previewRows(ladder, rules, dto(ladder))[0]?.cells[0]).not.toHaveProperty("family");
  });
});
