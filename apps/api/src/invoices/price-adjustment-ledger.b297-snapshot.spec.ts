import {
  buildPriceAdjustmentUpdates,
  loadPriceAdjustmentReference,
} from "./price-adjustment-ledger";

/**
 * B297 PR3 (SA-734r2 B3 / L1 / A3): a price adjustment on an invoice re-derives a regulated line's
 * excise from the line's OWN rate snapshot, never the live category. A NULL-trio line prices at the live
 * category once, stamps the trio and warns naming the line; a line whose category was not loaded keeps
 * its stored amount; the live category is loaded only for NULL-trio lines.
 */
const RAISED = { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: "0.0700", priceIncludesTax: false };
const PCT = { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: "0.1000", priceIncludesTax: false };

const line = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  invoiceId: "inv-1",
  productId: "p1",
  description: "Widget",
  trackedCategoryId: "cat-1",
  unitPrice: 10,
  discount: 0,
  subtotal: 120,
  qty: 12,
  taxRate: 0,
  categoryTaxAmount: 0.6,
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: "0.0500",
  categoryPriceIncludesTax: false,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  promoFreeUnits: null,
  orderItemId: null,
  ...over,
});

const NULLS = { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null };

const build = (
  items: any[],
  prices: Record<string, number>,
  categories: any[] = [RAISED],
  extra: Record<string, unknown> = {},
) =>
  buildPriceAdjustmentUpdates({
    items,
    localPriceMap: new Map(Object.entries(prices)),
    categoriesById: new Map(categories.map((c) => [c.id, c])),
    unitsPerBoxByProduct: new Map(),
    isTaxExempt: false,
    ...extra,
  });

describe("buildPriceAdjustmentUpdates: excise reads the line's snapshot (B297 PR3)", () => {
  it("a price change on a snapshot line leaves the excise at the SNAPSHOT rate after the live rate rose", () => {
    const warn = jest.fn();
    const [u] = build([line()], { i1: 11 }, [RAISED], { warn });
    expect(u.data.unitPrice).toBe(11);
    expect(u.data.categoryTaxAmount).toBe(0.6); // 12 x 0.05, not 12 x 0.07 = 0.84
    expect(u.data).not.toHaveProperty("categoryTaxType"); // a present trio is never rewritten
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not need the category loaded for a snapshot line", () => {
    const [u] = build([line()], { i1: 11 }, []);
    expect(u.data.categoryTaxAmount).toBe(0.6);
  });

  it("PERCENT_OF_SALE follows the new subtotal at the snapshot rate", () => {
    const [u] = build(
      [
        line({
          categoryTaxType: "PERCENT_OF_SALE",
          categoryTaxRate: "0.0600",
          categoryTaxAmount: 7.2,
        }),
      ],
      { i1: 11 },
      [PCT],
    );
    expect(u.data.subtotal).toBe(132);
    expect(u.data.categoryTaxAmount).toBe(7.92); // 132 x 0.06, not 132 x 0.10
  });

  it("a NULL-trio line prices at the live category once, stamps the full trio and warns naming the line", () => {
    const warn = jest.fn();
    const [u] = build([line({ ...NULLS })], { i1: 11 }, [RAISED], { warn });
    expect(u.data.categoryTaxAmount).toBe(0.84);
    expect(u.data).toMatchObject({
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.07,
      categoryPriceIncludesTax: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("i1");
  });

  it("a NULL-trio line whose category was not loaded keeps its stored amount and stamps nothing", () => {
    const warn = jest.fn();
    const [u] = build([line({ ...NULLS })], { i1: 11 }, [], { warn });
    expect(u.data).not.toHaveProperty("categoryTaxAmount");
    expect(u.data).not.toHaveProperty("categoryTaxType");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an exempt customer's regulated line is still zeroed on this path, with no stamp", () => {
    const [u] = build([line({ ...NULLS })], { i1: 11 }, [RAISED], { isTaxExempt: true });
    expect(u.data.categoryTaxAmount).toBe(0);
    expect(u.data).not.toHaveProperty("categoryTaxType");
  });

  it("a line with no category is not given a levy write at all (its stored amount stays)", () => {
    const [u] = build([line({ trackedCategoryId: null, ...NULLS, categoryTaxAmount: 4.2 })], {
      i1: 11,
    });
    expect(u.data).not.toHaveProperty("categoryTaxAmount");
  });

  it("an unchanged price is skipped, whatever the snapshot", () => {
    expect(build([line()], { i1: 10 })).toEqual([]);
  });
});

describe("loadPriceAdjustmentReference: categories only for NULL-trio lines (A3)", () => {
  const db = () => ({
    trackedCategory: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
  });

  it("reads no category when every re-priced line carries its own trio, but still reads the pack", async () => {
    const tx = db();
    await loadPriceAdjustmentReference(tx as any, [line()], new Map([["i1", 11]]));
    expect(tx.trackedCategory.findMany).not.toHaveBeenCalled();
    expect(tx.product.findMany).toHaveBeenCalledTimes(1);
  });

  it("reads the category of a NULL-trio line only", async () => {
    const tx = db();
    await loadPriceAdjustmentReference(
      tx as any,
      [
        line({ id: "snap", trackedCategoryId: "cat-1" }),
        line({ id: "nul", trackedCategoryId: "cat-2", ...NULLS }),
      ],
      new Map([
        ["snap", 11],
        ["nul", 11],
      ]),
    );
    expect(tx.trackedCategory.findMany).toHaveBeenCalledWith({ where: { id: { in: ["cat-2"] } } });
  });
});
