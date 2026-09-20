import { buildManualInvoiceLines } from "./manual-invoice-lines";

// The manual-invoice line builder, lifted verbatim out of InvoicesService.create() (4c-1 prefactor).
// InvoicesService.create's own specs pin it end to end; this pins the extracted contract.
const productMap = new Map([
  [
    "boxed",
    { id: "boxed", unitsPerBox: 12, trackedCategoryId: "cat", trackedSubcategoryId: "sub" },
  ],
  [
    "loose",
    { id: "loose", unitsPerBox: null, trackedCategoryId: null, trackedSubcategoryId: null },
  ],
]);
const categoryMap = new Map([
  ["cat", { taxType: "PERCENT_OF_SALE", rate: 0.1, priceIncludesTax: false }],
]);
const clamp = (free: number | undefined, boxes: number | null, qty: number) =>
  Math.min(Math.max(0, free ?? 0), Math.max(0, (boxes ?? qty) - 1));
const build = (items: unknown[]) =>
  buildManualInvoiceLines(items as never, {
    productMap,
    categoryMap,
    tenantId: "t-1",
    clampFreeUnits: clamp,
  });

describe("buildManualInvoiceLines", () => {
  it("splits a boxed line into boxes/pieces, prices it per box, snapshots the pack and the tracked category", () => {
    const { itemsData, subtotal } = build([
      { description: "Boxed", productId: "boxed", qty: 1, boxes: 2, pieces: 6, unitPrice: 24 },
    ]);
    expect(itemsData[0]).toMatchObject({
      qty: 30,
      boxes: 2,
      pieces: 6,
      unitsPerBox: 12,
      subtotal: 60, // 2 boxes + 6/12 box at $24 = 2.5 x 24
      trackedCategoryId: "cat",
      trackedSubcategoryId: "sub",
      categoryTaxAmount: 6, // 10% of the 60 sale
      tenantId: "t-1", // a nested create bypasses forTenant()
    });
    expect(subtotal).toBe(60);
  });

  it("a non-product line is qty x price minus the line discount, untracked; the subtotal sums the lines", () => {
    const { itemsData, subtotal } = build([
      { description: "Fee", qty: 3, unitPrice: 10, discount: 5 },
      { description: "Loose", productId: "loose", qty: 2, unitPrice: 4.5 },
    ]);
    expect(itemsData.map((l) => l.subtotal)).toEqual([25, 9]);
    expect(itemsData[0]).toMatchObject({ boxes: null, unitsPerBox: null, categoryTaxAmount: 0 });
    expect(subtotal).toBe(34);
  });

  it("clamps BUY_N_GET_M free units through the injected clamp, and stores null when none", () => {
    const { itemsData } = build([
      { description: "Bogo", productId: "loose", qty: 5, unitPrice: 10, promoFreeUnits: 99 },
      { description: "Plain", productId: "loose", qty: 5, unitPrice: 10 },
    ]);
    expect(itemsData[0].promoFreeUnits).toBe(4); // capped at units - 1
    expect(itemsData[0].subtotal).toBe(10);
    expect(itemsData[1].promoFreeUnits).toBeNull();
  });
});
