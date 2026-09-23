import { loadCategoryMapForProducts } from "./category-map";

const category = { taxType: "EXCISE_PER_UNIT", rate: 0.5, priceIncludesTax: false };
const regulatedProduct = { id: "p1", trackedCategoryId: "cat-1" };
const unregulatedProduct = { id: "p2" };

describe("loadCategoryMapForProducts", () => {
  it("skips the query entirely when nothing in products is regulated", async () => {
    const findMany = jest.fn();
    const map = await loadCategoryMapForProducts(
      { trackedCategory: { findMany } },
      new Map([["p2", unregulatedProduct]]),
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("fetches and keys by trackedCategoryId for every regulated product, de-duplicated", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: "cat-1", ...category }]);
    const map = await loadCategoryMapForProducts(
      { trackedCategory: { findMany } },
      new Map([
        ["p1", regulatedProduct],
        ["p1b", { ...regulatedProduct, id: "p1b" }],
      ]),
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ["cat-1"] } } });
    expect(map.get("cat-1")).toEqual({ id: "cat-1", ...category });
  });

  it("also accepts a plain iterable (not just a Map) of product-like rows", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: "cat-1", ...category }]);
    const map = await loadCategoryMapForProducts({ trackedCategory: { findMany } }, [
      regulatedProduct,
      unregulatedProduct,
    ]);
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ["cat-1"] } } });
    expect(map.get("cat-1")).toEqual({ id: "cat-1", ...category });
  });
});
