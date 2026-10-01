import { pieceUnitLabel } from "./stock-shortfall-unit";

describe("pieceUnitLabel", () => {
  it("is the product's unit when it is not packed (null, 0 or 1 per box)", () => {
    for (const unitsPerBox of [null, undefined, 0, 1]) {
      expect(pieceUnitLabel({ unit: "lb", unitsPerBox })).toBe("lb");
    }
  });
  it("is omitted for a packed product: Product.unit names the PACK there", () => {
    expect(pieceUnitLabel({ unit: "Box", unitsPerBox: 12 })).toBeUndefined();
    expect(pieceUnitLabel({ unit: "case", unitsPerBox: "24" })).toBeUndefined();
  });
  it("is omitted when the product has no unit", () => {
    expect(pieceUnitLabel({ unit: null, unitsPerBox: null })).toBeUndefined();
  });
});
