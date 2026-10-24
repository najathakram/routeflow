import { InvoicesService } from "./invoices.service";

/**
 * B297 row 373(a) (SA-734r2 r-note 8): invoice-from-order copies the ORDER LINE'S snapshot verbatim. An
 * uncategorised line stays uncategorised (and keeps its stored levy), whatever its product's category is now:
 * the copier never re-files a line under the live product. The authorization guards are a different thing (they
 * fail safe on the product) and are not copiers.
 */
const proto = () => Object.create(InvoicesService.prototype) as any;

const orderLine = (over: Record<string, unknown> = {}) => ({
  id: "li-1",
  productId: "prod-1",
  name: null,
  qty: 12,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice: 8,
  subtotal: 96,
  originalPrice: null,
  priceType: "STANDARD",
  promoFreeUnits: null,
  notes: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  categoryTaxAmount: 4.2,
  categoryTaxType: null,
  categoryTaxRate: null,
  categoryPriceIncludesTax: null,
  invoicedQty: 0,
  // the product has SINCE been put under a regulated category
  product: { name: "Widget", trackedCategoryId: "cat-live", trackedSubcategoryId: "sub-live" },
  ...over,
});

describe("order -> invoice copy (buildInvoiceItemData): the source line, never the product (row 373a)", () => {
  it("an uncategorised order line stays uncategorised and keeps its stored levy", () => {
    const item = proto().buildInvoiceItemData(orderLine(), 12, "tenant-1");
    expect(item.trackedCategoryId).toBeNull();
    expect(item.trackedSubcategoryId).toBeNull();
    expect(item.categoryTaxAmount).toBe(4.2);
    expect(item.categoryTaxType).toBeNull();
    expect(item.categoryTaxRate).toBeNull();
  });

  it("a partial bill of that line still carries no category and prorates the same stored levy", () => {
    const first = proto().buildInvoiceItemData(orderLine(), 6, "tenant-1");
    const second = proto().buildInvoiceItemData(orderLine(), 6, "tenant-1", { priorBilledQty: 6 });
    expect(first.trackedCategoryId).toBeNull();
    expect(second.trackedCategoryId).toBeNull();
    expect(first.categoryTaxAmount + second.categoryTaxAmount).toBe(4.2);
  });

  it("a categorised line carries its own category, subcategory and trio, not the product's", () => {
    const item = proto().buildInvoiceItemData(
      orderLine({
        trackedCategoryId: "cat-sold",
        trackedSubcategoryId: "sub-sold",
        categoryTaxType: "EXCISE_PER_UNIT",
        categoryTaxRate: "0.0500",
        categoryPriceIncludesTax: false,
      }),
      12,
      "tenant-1",
    );
    expect(item).toMatchObject({
      trackedCategoryId: "cat-sold",
      trackedSubcategoryId: "sub-sold",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.05,
      categoryPriceIncludesTax: false,
    });
  });
});

describe("invoice grouping reads the same category the copy carries (row 373a)", () => {
  it("an uncategorised line whose product is now a SEPARATE_INVOICE category stays in the standard invoice", async () => {
    const svc = proto();
    svc.logger = { warn: jest.fn() };
    const db = {
      trackedCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "cat-live", name: "Tobacco", invoiceTreatment: "SEPARATE_INVOICE" },
          ]),
      },
    };
    const groups = await svc.groupOrderLinesForInvoicing(
      [{ li: orderLine(), remainingQty: 12 }],
      db,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].trackedCategoryId).toBeNull();
    expect(db.trackedCategory.findMany).not.toHaveBeenCalled(); // no category named: nothing to look up
  });
});
