import {
  buildEditedLines,
  matchEditLines,
  withRowCategories,
  type StoredEditRow,
} from "./invoice-edit-plan";

/**
 * B297 PR3 (SA-734r2 R3 / L1): PATCH /invoices/:id re-prices a CHANGED matched row from the row's OWN rate
 * snapshot, not the live category. Only a new row and a product substitute stamp the live category. A NULL
 * trio prices at the live category once and stamps it, with a warn; a row with no category keeps a non-zero
 * stored levy instead of zeroing it. Exercises the REAL pure `matchEditLines` / `buildEditedLines`.
 */
const RAISED = { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: "0.0700", priceIncludesTax: false };
const OTHER = { id: "cat-2", taxType: "PERCENT_OF_SALE", rate: "0.1000", priceIncludesTax: false };

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
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  categoryTaxAmount: 0.6,
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: "0.0500",
  categoryPriceIncludesTax: false,
  ...over,
});

const NULL_TRIO = {
  categoryTaxType: null,
  categoryTaxRate: null,
  categoryPriceIncludesTax: null,
};

/** The edit payload: the stored line with the quantity changed to 6 (a changed, matched row). */
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

function plan(
  items: any[],
  stored: StoredEditRow[],
  {
    product = { id: "prod-1", unitsPerBox: null, trackedCategoryId: "cat-1" as string | null },
    categories = [RAISED] as any[],
  } = {},
) {
  const warn = jest.fn();
  const lines = buildEditedLines({
    items,
    stored,
    matches: matchEditLines(items, stored),
    productMap: new Map([
      [product.id, product],
      ["prod-2", { ...product, id: "prod-2" }],
    ]),
    categoryMap: new Map(categories.map((c) => [c.id, c])),
    clampFreeUnits: (free: number | undefined) => free ?? 0,
    warn,
  } as any);
  return { lines, warn };
}

describe("invoice edit plan: a matched row re-prices at its own snapshot (B297 PR3, R3)", () => {
  it("a changed qty on a row with a trio recomputes at the SNAPSHOT rate, not the raised live rate", () => {
    const { lines, warn } = plan([item()], [row()]);
    expect(lines[0].data.categoryTaxAmount).toBe(0.3); // 6 x 0.05, not 6 x 0.07 = 0.42
    expect(lines[0].data).toMatchObject({
      trackedCategoryId: "cat-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.05,
      categoryPriceIncludesTax: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the row's own category and trio when the product has since moved to another category", () => {
    const { lines } = plan([item()], [row()], {
      product: { id: "prod-1", unitsPerBox: null, trackedCategoryId: "cat-2" },
      categories: [RAISED, OTHER],
    });
    expect(lines[0].data.trackedCategoryId).toBe("cat-1");
    expect(lines[0].data.categoryTaxAmount).toBe(0.3);
    expect(lines[0].data.categoryTaxType).toBe("EXCISE_PER_UNIT");
  });

  it("a NULL-trio row prices at the live category once, stamps the trio, and warns naming the row", () => {
    const { lines, warn } = plan([item()], [row({ ...NULL_TRIO })]);
    expect(lines[0].data.categoryTaxAmount).toBe(0.42);
    expect(lines[0].data).toMatchObject({
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.07,
      categoryPriceIncludesTax: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("row-1");
  });

  it("a NULL-trio row prices at ITS OWN category even when the product has moved to another (no move to D)", () => {
    const { lines } = plan([item()], [row({ ...NULL_TRIO })], {
      product: { id: "prod-1", unitsPerBox: null, trackedCategoryId: "cat-2" },
      categories: [RAISED, OTHER],
    });
    expect(lines[0].data.trackedCategoryId).toBe("cat-1");
    expect(lines[0].data.categoryTaxAmount).toBe(0.42); // cat-1 live (6 x 0.07), not cat-2's 10% of the subtotal
    expect(lines[0].data.categoryTaxRate).toBe(0.07);
  });

  it("a NULL-trio row whose product lost its category still prices at the row's own category", () => {
    const { lines } = plan([item()], [row({ ...NULL_TRIO })], {
      product: { id: "prod-1", unitsPerBox: null, trackedCategoryId: null },
    });
    expect(lines[0].data.trackedCategoryId).toBe("cat-1");
    expect(lines[0].data.categoryTaxAmount).toBe(0.42); // not the kept 0.60, not 0
  });

  it("withRowCategories reads only the categories of NULL-trio rows that the map lacks", async () => {
    const db = { trackedCategory: { findMany: jest.fn().mockResolvedValue([OTHER]) } };
    const map = new Map<string, any>([["cat-1", RAISED]]);
    const out = await withRowCategories(
      db,
      [
        row({ id: "a", trackedCategoryId: "cat-1", ...NULL_TRIO }), // already in the map
        row({ id: "b", trackedCategoryId: "cat-2", ...NULL_TRIO }), // missing => read
        row({ id: "c", trackedCategoryId: "cat-3" }), // full trio => not read
        row({ id: "d", trackedCategoryId: null, ...NULL_TRIO }), // no category
      ],
      map,
    );
    expect(db.trackedCategory.findMany).toHaveBeenCalledWith({ where: { id: { in: ["cat-2"] } } });
    expect([...out.keys()].sort()).toEqual(["cat-1", "cat-2"]);
    const none = { trackedCategory: { findMany: jest.fn() } };
    expect(await withRowCategories(none, [row()], map)).toBe(map);
    expect(none.trackedCategory.findMany).not.toHaveBeenCalled();
  });

  it("a partly NULL trio is NULL: it stamps the full live trio", () => {
    const { lines } = plan([item()], [row({ categoryPriceIncludesTax: null })]);
    expect(lines[0].data.categoryTaxRate).toBe(0.07);
    expect(lines[0].data.categoryTaxAmount).toBe(0.42);
  });

  it("a product substitute and a new row stamp the live category (they are new sales)", () => {
    const sub = plan([item({ productId: "prod-2" })], [row()]);
    expect(sub.lines[0].data.categoryTaxAmount).toBe(0.42);
    expect(sub.lines[0].data.categoryTaxRate).toBe(0.07);
    expect(sub.warn).not.toHaveBeenCalled();

    const added = plan([item({ id: undefined })], [row({ id: "row-9", qty: 99 })]);
    expect(added.lines[0].rowId).toBeNull();
    expect(added.lines[0].data.categoryTaxAmount).toBe(0.42);
    expect(added.lines[0].data.categoryTaxRate).toBe(0.07);
    expect(added.warn).not.toHaveBeenCalled();
  });

  it("KEEPS a no-category row's stored levy through a qty edit, with a warn, instead of zeroing it [L1]", () => {
    const { lines, warn } = plan(
      [item()],
      [row({ trackedCategoryId: null, ...NULL_TRIO, categoryTaxAmount: 4.2 })],
      { product: { id: "prod-1", unitsPerBox: null, trackedCategoryId: null }, categories: [] },
    );
    expect(lines[0].data.categoryTaxAmount).toBe(4.2);
    expect(lines[0].data.trackedCategoryId).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("row-1");
  });

  it("row 338: a no-category row with a stored levy KEEPS it, and stays category-less, even when its product is regulated now [L1]", () => {
    const { lines, warn } = plan(
      [item()],
      [row({ trackedCategoryId: null, ...NULL_TRIO, categoryTaxAmount: 4.2 })],
    ); // the product is in cat-1 (RAISED) now: it must not move the line there and re-price it
    expect(lines[0].data.categoryTaxAmount).toBe(4.2);
    expect(lines[0].data.trackedCategoryId).toBeNull();
    expect(lines[0].data.categoryTaxRate).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("row-1");
  });

  it("row 338 (SA MED-1): a no-category row with a ZERO levy stays category-less at 0 even when its product is regulated now", () => {
    const { lines, warn } = plan(
      [item()],
      [row({ trackedCategoryId: null, ...NULL_TRIO, categoryTaxAmount: 0 })],
    ); // the product is in cat-1 (RAISED) now: a line sold uncategorised is not filed under it on an edit
    expect(lines[0].data.categoryTaxAmount).toBe(0);
    expect(lines[0].data.trackedCategoryId).toBeNull();
    expect(lines[0].data.categoryTaxRate).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a no-category row with a zero levy stays 0, silently", () => {
    const { lines, warn } = plan(
      [item()],
      [row({ trackedCategoryId: null, ...NULL_TRIO, categoryTaxAmount: 0 })],
      { product: { id: "prod-1", unitsPerBox: null, trackedCategoryId: null }, categories: [] },
    );
    expect(lines[0].data.categoryTaxAmount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an untouched row is still carried verbatim (stored levy and trio)", () => {
    const { lines } = plan([item({ qty: 12 })], [row()]);
    expect(lines[0].untouched).toBe(true);
    expect(lines[0].data.categoryTaxAmount).toBe(0.6);
    expect(lines[0].data.categoryTaxRate).toBe("0.0500");
  });
});
