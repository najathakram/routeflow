import { groupLinesForInvoiceSplit, type InvoiceSplitCategory } from "../lib/invoice-split";

const cat = (over: Partial<InvoiceSplitCategory> & { id: string }): InvoiceSplitCategory => ({
  name: over.id,
  invoiceTreatment: "SEPARATE_INVOICE",
  ...over,
});

describe("groupLinesForInvoiceSplit", () => {
  it("no lines → no groups, no split", () => {
    const r = groupLinesForInvoiceSplit([], new Map());
    expect(r).toEqual({ groups: [], willSplit: false });
  });

  it("LOCKS: all-standard lines (no trackedCategoryId) → a SINGLE 'Standard' group, no split", () => {
    const r = groupLinesForInvoiceSplit(
      [
        { unitPrice: 10, qty: 2 },
        { unitPrice: 5, qty: 3 },
      ],
      new Map(),
    );
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Standard", count: 2, subtotal: 35 }]);
  });

  it("regulated line whose category is SEPARATE_SECTION folds into Standard, no split", () => {
    const categoryById = new Map([
      ["alcohol", cat({ id: "alcohol", name: "Alcohol", invoiceTreatment: "SEPARATE_SECTION" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [
        { unitPrice: 10, qty: 1 },
        { trackedCategoryId: "alcohol", unitPrice: 20, qty: 1 },
      ],
      categoryById,
    );
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Standard", count: 2, subtotal: 30 }]);
  });

  it("regulated line whose category is LINE_TAX folds into Standard, no split", () => {
    const categoryById = new Map([
      ["crv", cat({ id: "crv", name: "CRV Deposits", invoiceTreatment: "LINE_TAX" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [{ trackedCategoryId: "crv", unitPrice: 12, qty: 4 }],
      categoryById,
    );
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 48 }]);
  });

  it("a trackedCategoryId not present in categoryById (deactivated/unknown) folds into Standard", () => {
    const r = groupLinesForInvoiceSplit(
      [{ trackedCategoryId: "missing-id", unitPrice: 10, qty: 1 }],
      new Map(),
    );
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 10 }]);
  });

  it("one standard line + one SEPARATE_INVOICE line → two groups, Standard first, willSplit=true", () => {
    const categoryById = new Map([
      ["tobacco", cat({ id: "tobacco", name: "Tobacco", invoiceTreatment: "SEPARATE_INVOICE" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [
        { unitPrice: 10, qty: 1 },
        { trackedCategoryId: "tobacco", unitPrice: 8, qty: 2 },
      ],
      categoryById,
    );
    expect(r.willSplit).toBe(true);
    expect(r.groups).toEqual([
      { label: "Standard", count: 1, subtotal: 10 },
      { label: "Tobacco", count: 1, subtotal: 16 },
    ]);
  });

  it("only SEPARATE_INVOICE lines in ONE category → single group, NO split (server makes one invoice)", () => {
    const categoryById = new Map([["tobacco", cat({ id: "tobacco", name: "Tobacco" })]]);
    const r = groupLinesForInvoiceSplit(
      [{ trackedCategoryId: "tobacco", unitPrice: 8, qty: 2 }],
      categoryById,
    );
    // A regulated-only cart with a single SEPARATE_INVOICE category is ONE group, so
    // createSplitInvoices creates exactly one invoice (invoiceGroupId=null) — no split.
    expect(r.willSplit).toBe(false);
    expect(r.groups).toEqual([{ label: "Tobacco", count: 1, subtotal: 16 }]);
  });

  it("two DIFFERENT SEPARATE_INVOICE categories, no standard lines → two groups, willSplit=true", () => {
    const categoryById = new Map([
      ["tobacco", cat({ id: "tobacco", name: "Tobacco" })],
      ["alcohol", cat({ id: "alcohol", name: "Alcohol" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [
        { trackedCategoryId: "tobacco", unitPrice: 8, qty: 2 },
        { trackedCategoryId: "alcohol", unitPrice: 20, qty: 1 },
      ],
      categoryById,
    );
    expect(r.willSplit).toBe(true);
    expect(r.groups).toEqual([
      { label: "Alcohol", count: 1, subtotal: 20 },
      { label: "Tobacco", count: 1, subtotal: 16 },
    ]);
  });

  it("multiple SEPARATE_INVOICE categories are sorted by name, independent of input/insertion order", () => {
    const categoryById = new Map([
      ["tobacco", cat({ id: "tobacco", name: "Tobacco" })],
      ["alcohol", cat({ id: "alcohol", name: "Alcohol" })],
    ]);
    const r = groupLinesForInvoiceSplit(
      [
        { trackedCategoryId: "tobacco", unitPrice: 8, qty: 1 },
        { trackedCategoryId: "alcohol", unitPrice: 20, qty: 1 },
      ],
      categoryById,
    );
    expect(r.groups.map((g) => g.label)).toEqual(["Alcohol", "Tobacco"]);
  });

  it("multiple lines in the SAME SEPARATE_INVOICE category accumulate into one group", () => {
    const categoryById = new Map([["tobacco", cat({ id: "tobacco", name: "Tobacco" })]]);
    const r = groupLinesForInvoiceSplit(
      [
        { trackedCategoryId: "tobacco", unitPrice: 8, qty: 1 },
        { trackedCategoryId: "tobacco", unitPrice: 5, qty: 2 },
      ],
      categoryById,
    );
    expect(r.groups).toEqual([{ label: "Tobacco", count: 2, subtotal: 18 }]);
  });

  it("cent-parity: a boxed line's subtotal uses computeLineSubtotal's box-equivalent formula", () => {
    // Guarded-failure case mirrored from shelf-logic.test.ts: qty*unitPrice would
    // wrongly give 24*30=720; the correct boxed math is boxes(2)*unitPrice(30)=60.
    const r = groupLinesForInvoiceSplit(
      [{ unitPrice: 30, qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }],
      new Map(),
    );
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 60 }]);
  });

  it("an unlisted-style line (no trackedCategoryId, no boxes/unitsPerBox) is simple qty*unitPrice", () => {
    const r = groupLinesForInvoiceSplit([{ unitPrice: 4.5, qty: 3 }], new Map());
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 13.5 }]);
  });

  it("a zero-qty/negative-subtotal line the caller forgot to filter still sums without throwing", () => {
    const r = groupLinesForInvoiceSplit([{ unitPrice: 10, qty: 0 }], new Map());
    expect(r.groups).toEqual([{ label: "Standard", count: 1, subtotal: 0 }]);
  });
});
