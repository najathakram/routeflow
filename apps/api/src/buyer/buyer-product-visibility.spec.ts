import {
  buyerVisibleProductByIdWhere,
  buyerVisibleProductWhere,
  isBuyerVisibleProduct,
} from "./buyer-product-visibility";

const BASE = [
  { isActive: true },
  { portalVisible: true },
  { OR: [{ parentProductId: null }, { parent: { portalVisible: true } }] },
];

describe("buyerVisibleProductWhere", () => {
  it("is active AND portal-visible AND (standalone OR visible parent)", () => {
    expect(buyerVisibleProductWhere()).toEqual({ AND: BASE });
  });

  it("AND-merges extra as its own trailing clause", () => {
    expect(buyerVisibleProductWhere({ category: "Drinks" })).toEqual({
      AND: [...BASE, { category: "Drinks" }],
    });
  });

  it("extra can never override portalVisible/isActive (nested, not spread)", () => {
    const w = buyerVisibleProductWhere({ portalVisible: false, isActive: false }) as {
      AND: unknown[];
    };
    expect(w).not.toHaveProperty("portalVisible");
    expect(w).not.toHaveProperty("isActive");
    expect(w.AND.slice(0, 3)).toEqual(BASE);
    expect(w.AND[3]).toEqual({ portalVisible: false, isActive: false });
  });

  it("id helper is the builder with { id }", () => {
    expect(buyerVisibleProductByIdWhere("p1")).toEqual(buyerVisibleProductWhere({ id: "p1" }));
  });
});

describe("isBuyerVisibleProduct (in-memory twin)", () => {
  it("visible only when active, not hidden, parent not hidden", () => {
    expect(isBuyerVisibleProduct({ isActive: true })).toBe(true);
    expect(isBuyerVisibleProduct({ isActive: true, portalVisible: true, parent: null })).toBe(true);
    expect(isBuyerVisibleProduct({ isActive: false })).toBe(false);
    expect(isBuyerVisibleProduct({ isActive: true, portalVisible: false })).toBe(false);
    expect(
      isBuyerVisibleProduct({
        isActive: true,
        portalVisible: true,
        parent: { portalVisible: false },
      }),
    ).toBe(false);
  });
});
