import { isSellableProduct, sellableProductWhere } from "./sellable-product-where";

const PARENT_LIVE = { OR: [{ parentProductId: null }, { parent: { isActive: true } }] };

describe("sellableProductWhere (WS6/WS8, B1213)", () => {
  it("is active AND not a FAMILY AND (standalone OR its parent family is active)", () => {
    expect(sellableProductWhere()).toEqual({
      AND: [{ isActive: true }, { kind: { not: "FAMILY" } }, PARENT_LIVE],
    });
  });

  it("AND-merges extra as its own clause (narrows, never widens)", () => {
    expect(sellableProductWhere({ kind: "FAMILY" })).toEqual({
      AND: [{ isActive: true }, { kind: { not: "FAMILY" } }, PARENT_LIVE, { kind: "FAMILY" }],
    });
  });

  it("the in-memory twin agrees", () => {
    const p = { isActive: true, kind: "STANDARD", parent: null };
    expect(isSellableProduct(p)).toBe(true);
    expect(isSellableProduct({ ...p, kind: "VARIANT" })).toBe(true);
    expect(isSellableProduct({ ...p, kind: "FAMILY" })).toBe(false);
    expect(isSellableProduct({ ...p, isActive: false })).toBe(false);
  });

  it("a variant under an INACTIVE parent family is not sellable; under an active one it is", () => {
    const v = { isActive: true, kind: "VARIANT" };
    expect(isSellableProduct({ ...v, parent: { isActive: true } })).toBe(true);
    expect(isSellableProduct({ ...v, parent: { isActive: false } })).toBe(false);
  });

  it("the parent is REQUIRED: a select that forgets it is a compile error, never a silently sellable product", () => {
    // Compile-time pin only: the call lives in a function that is never invoked.
    const compileOnly = () => {
      const noParent = { isActive: true, kind: "VARIANT" };
      // @ts-expect-error parent missing (null = standalone must be explicit)
      isSellableProduct(noParent);
    };
    expect(typeof compileOnly).toBe("function");
  });
});
