/**
 * #2728 M1 (SA-572a, R12, T15) — unit spec for `prisma/report-product-barcode-conflicts.ts`'s pure
 * counter `countBarcodeConflicts(rows, products)`. Read-only; no DB spec needed for the pure fn (a
 * `main()` smoke covers wiring only, exercised by hand).
 */
import {
  countBarcodeConflicts,
  formatErrorForStderr,
} from "../../prisma/report-product-barcode-conflicts";

describe("countBarcodeConflicts", () => {
  it("counts a code held by more than one product (per tenant) exactly once", () => {
    const rows = [
      { tenantId: "t1", productId: "p1", code: "036000291452", level: "BOX" },
      { tenantId: "t1", productId: "p2", code: "036000291452", level: "BOX" },
    ];
    const products = [
      { id: "p1", tenantId: "t1", barcode: "036000291452", unitsPerBox: 12, hasRows: true },
      { id: "p2", tenantId: "t1", barcode: "036000291452", unitsPerBox: 12, hasRows: true },
    ];
    const result = countBarcodeConflicts(rows, products);
    expect(result.codesOnMultipleProducts).toBe(1);
  });

  it("counts a product whose rows drift from what its legacy columns would plan", () => {
    const rows = [
      // Drifted: legacy plans BOX+UNIT for upb 12, but this product only has a UNIT row.
      { tenantId: "t1", productId: "pDrift", code: "036000291452", level: "UNIT" },
    ];
    const products = [
      { id: "pDrift", tenantId: "t1", barcode: "036000291452", unitsPerBox: 12, hasRows: true },
    ];
    const result = countBarcodeConflicts(rows, products);
    expect(result.productsDriftedFromLegacy).toBe(1);
  });

  it("a clean product (rows match the plan, code held by one product) counts as 0/0", () => {
    const rows = [
      {
        tenantId: "t1",
        productId: "pClean",
        code: "12345678",
        level: "UNIT",
        origin: "ENTERED",
        copiedFromLevel: null,
        primaryFor: "UNIT",
      },
    ];
    const products = [
      { id: "pClean", tenantId: "t1", barcode: "12345678", unitsPerBox: 1, hasRows: true },
    ];
    const result = countBarcodeConflicts(rows, products);
    expect(result.codesOnMultipleProducts).toBe(0);
    expect(result.productsDriftedFromLegacy).toBe(0);
  });

  it("same (code, level) but a different origin/primary is drift too (the full mirror tuple)", () => {
    const rows = [
      // upb 1 plans UNIT ENTERED primary UNIT; this row says COPIED from BOX: a stale mirror.
      {
        tenantId: "t1",
        productId: "pStale",
        code: "12345678",
        level: "UNIT",
        origin: "COPIED",
        copiedFromLevel: "BOX",
        primaryFor: "UNIT",
      },
    ];
    const products = [
      { id: "pStale", tenantId: "t1", barcode: "12345678", unitsPerBox: 1, hasRows: true },
    ];
    expect(countBarcodeConflicts(rows, products).productsDriftedFromLegacy).toBe(1);
  });

  it("a product with no rows (hasRows: false) is never counted as drifted", () => {
    const products = [
      { id: "pNoRows", tenantId: "t1", barcode: "12345678", unitsPerBox: 1, hasRows: false },
    ];
    const result = countBarcodeConflicts([], products);
    expect(result.productsDriftedFromLegacy).toBe(0);
  });
});

// (g) #2728 M1 follow-up, pre-merge BLOCK: main()'s catch must never print a raw error
// object/message (it can carry a tenant slug, product name, or barcode value) — only name (+code).
describe("formatErrorForStderr — never leaks the raw error message/meta/stack", () => {
  it("formats a plain Error as just its name, no message", () => {
    expect(formatErrorForStderr(new Error("tenant acme-live has barcode 0000000000012"))).toBe(
      "Error",
    );
  });

  it("appends the code when the error carries one (e.g. a Prisma error)", () => {
    const err = Object.assign(new Error("Unique constraint failed on tenant acme-live"), {
      code: "P2002",
    });
    expect(formatErrorForStderr(err)).toBe("Error P2002");
  });

  it("falls back to a generic label for a non-Error throw", () => {
    expect(formatErrorForStderr("tenant acme-live: barcode taken")).toBe("Error");
  });
});
