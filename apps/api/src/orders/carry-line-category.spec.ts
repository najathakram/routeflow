import { carriedCategory } from "./carry-line-category";
import { buildExistingLineMaps } from "./replace-all-line-build";

/**
 * B297 row 340: a merge fold re-creates every line, and a line that comes from an existing line carries that
 * line's OWN category and trio instead of re-stamping from the product's current category.
 */
const own = (over: Record<string, unknown> = {}) => ({
  productId: "p1",
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: "sub-1",
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: "0.0500",
  categoryPriceIncludesTax: false,
  categoryTaxAmount: "0.60",
  ...over,
});

describe("carriedCategory", () => {
  it("carries a full trio's category, subcategory and trio verbatim", () => {
    expect(carriedCategory(own(), "p1")).toEqual({
      trackedCategoryId: "cat-1",
      trackedSubcategoryId: "sub-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.05,
      categoryPriceIncludesTax: false,
    });
  });

  it("keeps a no-category line category-less and carries its stored levy (L1)", () => {
    expect(
      carriedCategory(
        own({
          trackedCategoryId: null,
          trackedSubcategoryId: null,
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: null,
          categoryTaxAmount: "4.20",
        }),
        "p1",
      ),
    ).toEqual({
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      categoryTaxType: null,
      categoryTaxRate: null,
      categoryPriceIncludesTax: null,
      categoryTaxAmount: 4.2,
    });
  });

  it("a NULL or partly NULL trio keeps the line's OWN category with an empty trio (the recompute stamps it from that category)", () => {
    const expected = {
      trackedCategoryId: "cat-1",
      trackedSubcategoryId: "sub-1",
      categoryTaxType: null,
      categoryTaxRate: null,
      categoryPriceIncludesTax: null,
    };
    expect(
      carriedCategory(
        own({ categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null }),
        "p1",
      ),
    ).toEqual(expected);
    expect(carriedCategory(own({ categoryPriceIncludesTax: null }), "p1")).toEqual(expected);
  });

  it("carries nothing when the source line is another product, or missing (a genuinely new line)", () => {
    expect(carriedCategory(own({ productId: "p2" }), "p1")).toBeNull();
    expect(carriedCategory(undefined, "p1")).toBeNull();
    expect(carriedCategory(null, "p1")).toBeNull();
  });
});

describe("buildExistingLineMaps keeps each existing line's own category", () => {
  it("exposes the category facts by line id", () => {
    const { existingLineById } = buildExistingLineMaps(
      [
        {
          id: "li-1",
          productId: "p1",
          status: "PENDING",
          unitPrice: 1,
          priceType: "STANDARD" as any,
          originalPrice: null,
          trackedCategoryId: "cat-1",
          trackedSubcategoryId: null,
          categoryTaxType: "EXCISE_PER_UNIT",
          categoryTaxRate: 0.05,
          categoryPriceIncludesTax: false,
          categoryTaxAmount: 0.6,
        },
      ],
      new Map(),
      new Map(),
    );
    expect(existingLineById.get("li-1")!.category).toMatchObject({
      productId: "p1",
      trackedCategoryId: "cat-1",
      categoryTaxRate: 0.05,
    });
  });
});
