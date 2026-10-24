import { buildEditedLines, matchEditLines, type StoredEditRow } from "./invoice-edit-plan";

/**
 * B297 row 338 (review fold): a CHANGED row that keeps its product keeps the reporting subcategory it was sold
 * under, exactly as it keeps its category and rate trio. The product's CURRENT subcategory is stamped only on a
 * new row or a product substitute (a new sale). Otherwise a product that later moved to D/Dsub would leave a
 * kept C row filed as C/Dsub, and a kept no-category row as (none)/Dsub, which the regulated ledger copies.
 */
const CAT_C = { id: "cat-c", taxType: "EXCISE_PER_UNIT", rate: "0.0700", priceIncludesTax: false };
const CAT_D = { id: "cat-d", taxType: "PERCENT_OF_SALE", rate: "0.1000", priceIncludesTax: false };
const MOVED_PRODUCT = {
  id: "prod-1",
  unitsPerBox: null,
  trackedCategoryId: "cat-d",
  trackedSubcategoryId: "sub-d",
};

const row = (over: Record<string, unknown> = {}): StoredEditRow => ({
  id: "row-1",
  invoiceId: "inv-1",
  productId: "prod-1",
  description: "Widget",
  qty: 12,
  unitPrice: 8.33,
  discount: 0,
  taxRate: 0,
  subtotal: 100,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  promoFreeUnits: null,
  notes: null,
  orderItemId: null,
  trackedCategoryId: "cat-c",
  trackedSubcategoryId: "sub-c",
  categoryTaxAmount: 0.6,
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: "0.0500",
  categoryPriceIncludesTax: false,
  ...over,
});

const item = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  productId: "prod-1",
  description: "Widget",
  qty: 6,
  unitPrice: 8.33,
  discount: 0,
  taxRate: 0,
  ...over,
});

function plan(items: any[], stored: StoredEditRow[]) {
  return buildEditedLines({
    items,
    stored,
    matches: matchEditLines(items, stored),
    productMap: new Map([
      ["prod-1", MOVED_PRODUCT],
      ["prod-2", { ...MOVED_PRODUCT, id: "prod-2" }],
    ]),
    categoryMap: new Map([CAT_C, CAT_D].map((c) => [c.id, c])),
    clampFreeUnits: (free: number | undefined) => free ?? 0,
    warn: jest.fn(),
  } as any);
}

describe("invoice edit plan: a kept row keeps its own subcategory (row 338)", () => {
  it("a kept row in C stays C / its own subcategory after the product moved to D / Dsub", () => {
    const [l] = plan([item()], [row()]);
    expect(l.data.trackedCategoryId).toBe("cat-c");
    expect(l.data.trackedSubcategoryId).toBe("sub-c");
  });

  it("a kept no-category row stays category-less AND subcategory-less, whatever its product is now", () => {
    const [l] = plan(
      [item()],
      [
        row({
          trackedCategoryId: null,
          trackedSubcategoryId: null,
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: null,
          categoryTaxAmount: 4.2,
        }),
      ],
    );
    expect(l.data.trackedCategoryId).toBeNull();
    expect(l.data.trackedSubcategoryId).toBeNull();
    expect(l.data.categoryTaxAmount).toBe(4.2);
  });

  it("a product substitute and a new row are new sales: they take the product's current subcategory", () => {
    const [sub] = plan([item({ productId: "prod-2" })], [row()]);
    expect(sub.data.trackedSubcategoryId).toBe("sub-d");
    const added = plan([item({ id: undefined })], [row({ id: "row-9", qty: 99 })]);
    expect(added[0].rowId).toBeNull();
    expect(added[0].data.trackedSubcategoryId).toBe("sub-d");
  });
});
