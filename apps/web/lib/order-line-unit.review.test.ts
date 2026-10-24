import type { CustomerLayerUnit } from "@routeflow/pricing";
import { applyLineUnit, repriceLineFromLayer, type UnitLine } from "./order-line-unit";
import { saleLinePricing } from "./sale-line-pricing";
import { withLayerPrices, type UnitOption } from "./unit-options";

// S19b slice B review fixes (Opus xhigh FAIL @9c5dc7f04): items 1, 2, 7 and the sale-line-pricing nit.
const tierPrices = { pricePerUnit: "42", priceTier2: "40", priceTier3: "38" };
const packRow: CustomerLayerUnit = {
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
};
type Line = UnitLine & { systemPrefill?: boolean; overrideReason?: string };
const line = (over: Partial<Line> = {}): Line => ({
  unit: "Bottle",
  qty: 1,
  listPrice: 42,
  unitPrice: 38,
  priceType: "SPECIAL",
  specialPrice: 38,
  tierPrices,
  ...over,
});

describe("review item 1: a system last-given pre-fill yields to the layer once it is ready", () => {
  it("a systemPrefill $36 DISCOUNTED line becomes the layer's $33 SPECIAL, no one-time price, no reason", () => {
    const prefilled = line({
      unitPrice: 36,
      priceType: "DISCOUNTED",
      discountedPrice: 36,
      systemPrefill: true,
      overrideReason: "x",
    });
    const r = repriceLineFromLayer(prefilled, { tier: 3, layer: [packRow] });
    expect(r.unitPrice).toBe(33);
    expect(r.discountedPrice).toBeUndefined();
    expect(r.priceType).toBe("SPECIAL");
    expect(r.overrideReason).toBeUndefined();
    expect(r.systemPrefill).toBeUndefined();
  });

  it("an operator-typed one-time price (no systemPrefill) still stands", () => {
    const typed = line({ unitPrice: 30, priceType: "DISCOUNTED", discountedPrice: 30 });
    expect(repriceLineFromLayer(typed, { tier: 3, layer: [packRow] })).toBe(typed);
  });
});

describe("review item 7: a row that disappears reprices the line to master's number", () => {
  it("layered $33, then no row: back to the tier price the line had before the layer", () => {
    const layered = repriceLineFromLayer(line(), { tier: 3, layer: [packRow] });
    expect(layered.unitPrice).toBe(33);
    const gone = repriceLineFromLayer(layered, { tier: 3, layer: [] });
    expect(gone.unitPrice).toBe(38);
    expect(gone.priceType).toBe("SPECIAL");
    expect(gone.specialPrice).toBe(38);
    // idempotent once restored
    expect(repriceLineFromLayer(gone, { tier: 3, layer: [] })).toBe(gone);
  });

  it("a changed layer price re-prices again (33 -> 31)", () => {
    const layered = repriceLineFromLayer(line(), { tier: 3, layer: [packRow] });
    const moved = repriceLineFromLayer(layered, { tier: 3, layer: [{ ...packRow, price: 31 }] });
    expect(moved.unitPrice).toBe(31);
  });

  it("a never-layered line with no layer is untouched", () => {
    const l = line();
    expect(repriceLineFromLayer(l, { tier: 3, layer: undefined })).toBe(l);
  });
});

describe("review item 2: a derived Piece is priced from the layer's pack", () => {
  const derivedOption = {
    value: "Piece",
    label: "Piece",
    factorToBase: 1,
    kind: "piece",
    price: 3.17,
    listPrice: 3.5,
    derived: { n: 12, packPrice: 38, exact: false },
  } as unknown as UnitOption;

  it("applyLineUnit with ctx.layer: the Piece line carries the pack at the layer's $33", () => {
    const caseLine = line({ unitLabel: "Case", packBase: { ...line(), qty: 1 } as never });
    const piece = applyLineUnit(caseLine, derivedOption, { tier: 3, layer: [packRow] });
    expect(piece.derivedBase).toBe("Piece");
    expect(piece.unitPrice).toBe(33);
  });

  it("withLayerPrices puts the layer's pack price on the derived option", () => {
    const product = { unit: "Bottle", unitsPerBox: 12, ...tierPrices } as never;
    const [o] = withLayerPrices([derivedOption], product, 3, [packRow]);
    expect(o.derived?.packPrice).toBe(33);
    const piece = applyLineUnit(
      line({ unitLabel: "Case", packBase: { ...line(), qty: 1 } as never }),
      o,
      { tier: 3 },
    );
    expect(piece.unitPrice).toBe(33);
  });

  it("repriceLineFromLayer prices a derived-base line from the pack row", () => {
    const l = line({ derivedBase: "Piece", unitsPerBox: 12, boxes: 0, pieces: 1 } as never);
    expect(repriceLineFromLayer(l, { tier: 3, layer: [packRow] }).unitPrice).toBe(33);
  });
});

describe("nit: sale-line-pricing goes through customerLinePrice", () => {
  it("no layer: master's numbers", () => {
    expect(saleLinePricing({ pricePerUnit: "42", priceTier3: "38" }, 3)).toEqual({
      tierPrice: 38,
      listPrice: 42,
      isSpecialTier: true,
    });
  });
});
