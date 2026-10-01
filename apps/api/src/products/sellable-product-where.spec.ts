import { isSellableProduct, sellableProductWhere } from "./sellable-product-where";

describe("sellableProductWhere (WS6/WS8)", () => {
  it("is active AND not a FAMILY", () => {
    expect(sellableProductWhere()).toEqual({
      AND: [{ isActive: true }, { kind: { not: "FAMILY" } }],
    });
  });

  it("AND-merges extra as its own clause (narrows, never widens)", () => {
    expect(sellableProductWhere({ kind: "FAMILY" })).toEqual({
      AND: [{ isActive: true }, { kind: { not: "FAMILY" } }, { kind: "FAMILY" }],
    });
  });

  it("the in-memory twin agrees", () => {
    expect(isSellableProduct({ isActive: true, kind: "STANDARD" })).toBe(true);
    expect(isSellableProduct({ isActive: true, kind: "VARIANT" })).toBe(true);
    expect(isSellableProduct({ isActive: true, kind: "FAMILY" })).toBe(false);
    expect(isSellableProduct({ isActive: false, kind: "STANDARD" })).toBe(false);
  });
});
