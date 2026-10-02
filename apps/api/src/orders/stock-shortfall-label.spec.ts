import { pieceUnitLabel } from "./stock-shortfall-label";

/**
 * `available` / `requested` on a stock-shortfall line count PIECES. For a boxed product
 * `Product.unit` names the PACK ("Box", "case"), so echoing it would make "Only 10 Box" overstate
 * stock by unitsPerBox. Only an unpacked product's `unit` is the piece noun.
 */
describe("pieceUnitLabel", () => {
  it("returns the unit for an unpacked product (unitsPerBox null)", () => {
    expect(pieceUnitLabel({ unit: "each", unitsPerBox: null })).toBe("each");
  });

  it("returns the unit when unitsPerBox is absent", () => {
    expect(pieceUnitLabel({ unit: "each" })).toBe("each");
  });

  it("returns the unit when the pack is exactly one (a pack of 1 is a piece)", () => {
    expect(pieceUnitLabel({ unit: "each", unitsPerBox: 1 })).toBe("each");
  });

  it("omits the unit for a boxed product, whose unit names the pack", () => {
    expect(pieceUnitLabel({ unit: "Box", unitsPerBox: 12 })).toBeUndefined();
  });

  it("treats a pack just over one as boxed", () => {
    expect(pieceUnitLabel({ unit: "Box", unitsPerBox: 2 })).toBeUndefined();
  });

  it("reads a Prisma Decimal-like pack through Number()", () => {
    expect(pieceUnitLabel({ unit: "Box", unitsPerBox: { valueOf: () => 24 } })).toBeUndefined();
  });

  it("returns undefined when there is no unit to give", () => {
    expect(pieceUnitLabel({ unit: null, unitsPerBox: null })).toBeUndefined();
    expect(pieceUnitLabel({ unitsPerBox: null })).toBeUndefined();
  });
});
