/**
 * #2728 M1 (SA-572a, R12, T15) — unit spec for `prisma/report-product-barcode-conflicts.ts`'s pure
 * counter `countBarcodeConflicts(rows, products)`. Read-only; no DB spec needed for the pure fn (a
 * `main()` smoke covers wiring only, exercised by hand).
 */
import {
  countBarcodeConflicts,
  formatErrorForStderr,
  loadCounts,
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

// #2728 M1 follow-up (SA-572f/g): three new counts — unmirroredProducts, the report's
// productsWithUnmirrorableImageKeys, and imageKeysHeldByAnotherProduct.
describe("countBarcodeConflicts — image-mirror counts (#2728 M1 follow-up)", () => {
  it("unmirroredProducts: a non-blank barcode with zero barcode rows counts once", () => {
    const products = [
      { id: "p1", tenantId: "t1", barcode: "999", unitsPerBox: 1, hasRows: false, imageKeys: [] },
    ];
    expect(countBarcodeConflicts([], products).unmirroredProducts).toBe(1);
  });

  it("unmirroredProducts: >=1 mirrorable image key with zero image rows counts once", () => {
    const products = [
      {
        id: "p2",
        tenantId: "t1",
        barcode: null,
        unitsPerBox: null,
        hasRows: false,
        imageKeys: ["products/p2/a.jpg"],
        hasImageRows: false,
      },
    ];
    expect(countBarcodeConflicts([], products).unmirroredProducts).toBe(1);
  });

  it("unmirroredProducts: missing BOTH barcode rows and image rows still counts the product ONCE", () => {
    const products = [
      {
        id: "p3",
        tenantId: "t1",
        barcode: "888",
        unitsPerBox: 1,
        hasRows: false,
        imageKeys: ["products/p3/a.jpg"],
        hasImageRows: false,
      },
    ];
    expect(countBarcodeConflicts([], products).unmirroredProducts).toBe(1);
  });

  it("unmirroredProducts: a clean product (rows present, no barcode/images) counts 0", () => {
    const products = [
      { id: "p4", tenantId: "t1", barcode: null, unitsPerBox: null, hasRows: false, imageKeys: [] },
    ];
    expect(countBarcodeConflicts([], products).unmirroredProducts).toBe(0);
  });

  it("productsWithUnmirrorableImageKeys: a duplicate legacy imageKeys entry counts the product", () => {
    const products = [
      {
        id: "p5",
        tenantId: "t1",
        barcode: null,
        unitsPerBox: null,
        hasRows: false,
        imageKeys: ["products/p5/a.jpg", "products/p5/a.jpg"],
        hasImageRows: true,
      },
    ];
    expect(countBarcodeConflicts([], products).productsWithUnmirrorableImageKeys).toBe(1);
  });

  it("productsWithUnmirrorableImageKeys: a foreign-prefixed legacy key counts the product", () => {
    const products = [
      {
        id: "p6",
        tenantId: "t1",
        barcode: null,
        unitsPerBox: null,
        hasRows: false,
        imageKeys: ["products/p6/a.jpg", "products/OTHER/b.jpg"],
        hasImageRows: true,
      },
    ];
    expect(countBarcodeConflicts([], products).productsWithUnmirrorableImageKeys).toBe(1);
  });

  it("productsWithUnmirrorableImageKeys: all-own, all-unique keys counts 0", () => {
    const products = [
      {
        id: "p7",
        tenantId: "t1",
        barcode: null,
        unitsPerBox: null,
        hasRows: false,
        imageKeys: ["products/p7/a.jpg", "products/p7/b.jpg"],
        hasImageRows: true,
      },
    ];
    expect(countBarcodeConflicts([], products).productsWithUnmirrorableImageKeys).toBe(0);
  });

  it("imageKeysHeldByAnotherProduct: counts KEYS, not products — a mirrorable key another product's row holds", () => {
    const products = [
      {
        id: "pA",
        tenantId: "t1",
        barcode: null,
        unitsPerBox: null,
        hasRows: false,
        imageKeys: ["products/pA/shared.jpg"],
        hasImageRows: false,
      },
    ];
    const imageRows = [{ tenantId: "t1", productId: "pB", storageKey: "products/pA/shared.jpg" }];
    expect(countBarcodeConflicts([], products, imageRows).imageKeysHeldByAnotherProduct).toBe(1);
  });

  it("imageKeysHeldByAnotherProduct: a key held by ITS OWN product's row is not counted", () => {
    const products = [
      {
        id: "pC",
        tenantId: "t1",
        barcode: null,
        unitsPerBox: null,
        hasRows: false,
        imageKeys: ["products/pC/own.jpg"],
        hasImageRows: true,
      },
    ];
    const imageRows = [{ tenantId: "t1", productId: "pC", storageKey: "products/pC/own.jpg" }];
    expect(countBarcodeConflicts([], products, imageRows).imageKeysHeldByAnotherProduct).toBe(0);
  });
});

// #2728 M1 follow-up (SA-572f, item D): no error text may echo a tenant slug; reads go through
// exactly one READ ONLY transaction.
describe("loadCounts — tenant-not-found is generic, reads run inside one READ ONLY transaction", () => {
  function mockTx() {
    return {
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      tenant: { findUnique: jest.fn() },
      productBarcode: { findMany: jest.fn().mockResolvedValue([]) },
      productImage: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
    };
  }

  it("an unknown --tenant slug throws a generic message (never echoes the slug)", async () => {
    const tx = mockTx();
    tx.tenant.findUnique.mockResolvedValue(null);
    const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) } as any;
    await expect(loadCounts(prisma, "acme-live-secret-slug")).rejects.toThrow();
    const err = await loadCounts(prisma, "acme-live-secret-slug").catch((e: Error) => e);
    expect((err as Error).message).not.toContain("acme-live-secret-slug");
  });

  it("runs everything inside ONE prisma.$transaction, and sets READ ONLY before any find*", async () => {
    const tx = mockTx();
    tx.tenant.findUnique.mockResolvedValue({ id: "t1" });
    const prisma = { $transaction: jest.fn((fn: any) => fn(tx)) } as any;
    await loadCounts(prisma, "test");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const raw = tx.$executeRaw.mock.invocationCallOrder[0];
    const firstFind = Math.min(
      tx.tenant.findUnique.mock.invocationCallOrder[0] ?? Infinity,
      ...tx.productBarcode.findMany.mock.invocationCallOrder,
      ...tx.product.findMany.mock.invocationCallOrder,
      ...tx.productImage.findMany.mock.invocationCallOrder,
    );
    expect(raw).toBeLessThan(firstFind);
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
