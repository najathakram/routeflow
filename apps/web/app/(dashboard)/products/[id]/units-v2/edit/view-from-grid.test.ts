import { priceGrid, type LadderView } from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { previewRows, rulesFromGrid, viewFromGrid } from "./view-from-grid";

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
  tierAnchors: v.tierAnchors,
  tierRules: rules,
  rows: priceGrid(v, rules).map((r) => ({ ...r, code: null })),
});

describe("viewFromGrid", () => {
  it("round-trips: priceGrid(viewFromGrid(dto)) equals the DTO cells", () => {
    const g = dto(view);
    const back = viewFromGrid(g);
    expect(priceGrid(back, rulesFromGrid(g))).toEqual(g.rows.map(({ code: _code, ...row }) => row));
    expect(back.tierAnchors).toEqual({ 3: "u1" });
  });

  it("missing tierAnchors / tierRules mean none", () => {
    const g = { ...dto(view), tierAnchors: undefined, tierRules: undefined };
    expect(viewFromGrid(g).tierAnchors).toEqual({});
    expect(rulesFromGrid(g)).toEqual({});
  });

  it("previewRows keeps each row's barcode", () => {
    const g = dto(view);
    g.rows[0].code = "0123";
    expect(previewRows(viewFromGrid(g), rulesFromGrid(g), g)[0].code).toBe("0123");
  });
});
