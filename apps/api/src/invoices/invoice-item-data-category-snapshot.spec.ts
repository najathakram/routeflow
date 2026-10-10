import { InvoicesService } from "./invoices.service";

/**
 * B297 (SA-088, D6) — split out of invoices.service.spec.ts's own
 * "buildInvoiceItemData (order line → invoice line)" describe block: that file sits exactly at
 * its size-ratchet ceiling (master is already at baseline + headroom), so new coverage goes in a
 * new module rather than growing it further (size-ratchet.spec.ts's own remedy).
 *
 * `buildInvoiceItemData` is pure — no `this.*` read, per the parent file's own "pure, so we
 * exercise it directly" note — so a bare `new InvoicesService(...)` with stub constructor args
 * is enough to call it; no DI module, no mocked collaborators.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const service = new InvoicesService(...(Array(15).fill(undefined) as any[]));
const build = (li: any, billQty: number) =>
  (service as any).buildInvoiceItemData(li, billQty, "test-tenant");

describe("buildInvoiceItemData — B297 rate-snapshot trio (SA-088 D6)", () => {
  it("copies the ORDER line's rate-snapshot trio verbatim, never the live category — the category's rate changed between sale and this rebuild", () => {
    const li = {
      id: "oi-reg",
      productId: "p-reg",
      qty: 10,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 10,
      subtotal: 100,
      trackedCategoryId: "cat-1",
      // Sold when the category's rate was 5% — frozen on the order line at sale time.
      categoryTaxType: "PERCENT_OF_SALE",
      categoryTaxRate: 0.05,
      categoryPriceIncludesTax: false,
      categoryTaxAmount: 5,
      // The LIVE category (e.g. read via li.product.trackedCategory in a real query) now sits
      // at a different rate — buildInvoiceItemData must never consult it for the trio.
      product: { name: "Widget", unitsPerBox: 0, trackedCategoryId: "cat-1" },
    };
    const line = build(li, 10);
    expect(line.categoryTaxType).toBe("PERCENT_OF_SALE");
    expect(line.categoryTaxRate).toBe(0.05);
    expect(line.categoryPriceIncludesTax).toBe(false);
  });

  it("a pre-B297 order line (no rate snapshot) yields a null invoice-line snapshot too — never invented from the live product/category", () => {
    const li = {
      id: "oi-legacy",
      productId: "p-reg",
      qty: 10,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 10,
      subtotal: 100,
      trackedCategoryId: "cat-1",
      categoryTaxAmount: 5,
      // No categoryTaxType/categoryTaxRate/categoryPriceIncludesTax fields at all (legacy row).
      product: { name: "Widget", unitsPerBox: 0, trackedCategoryId: "cat-1" },
    };
    const line = build(li, 10);
    expect(line.categoryTaxType).toBeNull();
    expect(line.categoryTaxRate).toBeNull();
    expect(line.categoryPriceIncludesTax).toBeNull();
  });
});
