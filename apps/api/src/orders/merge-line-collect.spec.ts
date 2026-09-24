import { collectMergeLines } from "./merge-line-collect";
import { PriceType } from "@prisma/client";

function loserLine(over: Partial<any> = {}) {
  return {
    productId: "p1",
    qty: 2,
    unitPrice: 2,
    boxes: null,
    pieces: null,
    promoFreeUnits: null,
    priceType: PriceType.STANDARD,
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    notes: null,
    trackedCategoryId: null,
    categoryTaxType: null,
    categoryTaxRate: null,
    categoryPriceIncludesTax: null,
    ...over,
  };
}

describe("collectMergeLines", () => {
  it("buckets a catalog line under both loserContribsByProduct and newItemMetaByProduct when the winner lacks it", () => {
    const result = collectMergeLines([{ lineItems: [loserLine()] }], new Set());

    expect(result.loserContribsByProduct.get("p1")).toHaveLength(1);
    expect(result.newItemMetaByProduct.get("p1")?.unitPrice).toBe(2);
  });

  it("skips newItemMetaByProduct when the winner already carries the product, but still records the contribution", () => {
    const result = collectMergeLines([{ lineItems: [loserLine()] }], new Set(["p1"]));

    expect(result.loserContribsByProduct.get("p1")).toHaveLength(1);
    expect(result.newItemMetaByProduct.has("p1")).toBe(false);
  });

  it("first occurrence wins the meta on a repeated product across losers", () => {
    const result = collectMergeLines(
      [{ lineItems: [loserLine({ unitPrice: 5 })] }, { lineItems: [loserLine({ unitPrice: 9 })] }],
      new Set(),
    );

    expect(result.newItemMetaByProduct.get("p1")?.unitPrice).toBe(5);
    expect(result.loserContribsByProduct.get("p1")).toHaveLength(2);
  });

  it("routes a catalog-free (productId: null) line into unlistedNewItems, never the product maps", () => {
    const result = collectMergeLines(
      [{ lineItems: [loserLine({ productId: null, name: "Custom" })] }],
      new Set(),
    );

    expect(result.unlistedNewItems).toEqual([expect.objectContaining({ name: "Custom", qty: 2 })]);
    expect(result.loserContribsByProduct.size).toBe(0);
    expect(result.newItemMetaByProduct.size).toBe(0);
  });

  it("B297: copies a regulated loser line's trio verbatim into newItemMetaByProduct, never re-deriving it", () => {
    const result = collectMergeLines(
      [
        {
          lineItems: [
            loserLine({
              trackedCategoryId: "cat-1",
              categoryTaxType: "EXCISE_PER_UNIT",
              categoryTaxRate: 0.5,
              categoryPriceIncludesTax: false,
            }),
          ],
        },
      ],
      new Set(),
    );

    const meta = result.newItemMetaByProduct.get("p1");
    expect(meta?.trackedCategoryId).toBe("cat-1");
    expect(meta?.categoryTaxType).toBe("EXCISE_PER_UNIT");
    expect(meta?.categoryTaxRate).toBe(0.5);
    expect(meta?.categoryPriceIncludesTax).toBe(false);
  });

  it("a non-regulated loser line carries an all-null trio through, nothing invented", () => {
    const result = collectMergeLines([{ lineItems: [loserLine()] }], new Set());

    const meta = result.newItemMetaByProduct.get("p1");
    expect(meta?.trackedCategoryId).toBeNull();
    expect(meta?.categoryTaxType).toBeNull();
    expect(meta?.categoryTaxRate).toBeNull();
    expect(meta?.categoryPriceIncludesTax).toBeNull();
  });
});
