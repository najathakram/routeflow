/**
 * #2728 M1 (SA-572a/b, R11/R12, T11/T12) — unit spec (mocked prisma) for
 * `prisma/backfill-product-catalog-rows.ts`'s `backfillProductCatalogRows(prisma, opts)`.
 *
 * Covers: every refusal fires BEFORE any prisma call; dry-run never calls createMany; the planned
 * counts for a fixed product set; the T12 source pin (no update/upsert/delete/raw-SQL anywhere in
 * the backfill file — it is INSERT-ONLY).
 *
 * The real-Postgres proof (apply arm, idempotent re-run, live-tenant refusal against a real row)
 * is backfill-product-catalog-rows.db.spec.ts (F2, not run here).
 */
import * as fs from "fs";
import * as path from "path";
import {
  backfillProductCatalogRows,
  BackfillRefused,
} from "../../prisma/backfill-product-catalog-rows";

function mockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    tenant: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    tenantSubscription: {
      findUnique: jest.fn(),
    },
    product: {
      findMany: jest.fn(),
    },
    productBarcode: {
      createMany: jest.fn(),
    },
    productImage: {
      createMany: jest.fn(),
    },
    ...overrides,
  } as any;
}

describe("backfillProductCatalogRows — refusals (before any prisma call)", () => {
  it("refuses when neither --tenant nor --all-tenants is given", async () => {
    const prisma = mockPrisma();
    await expect(backfillProductCatalogRows(prisma, { apply: false })).rejects.toThrow(
      BackfillRefused,
    );
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("refuses when both --tenant and --all-tenants are given", async () => {
    const prisma = mockPrisma();
    await expect(
      backfillProductCatalogRows(prisma, { tenantSlug: "test", allTenants: true, apply: false }),
    ).rejects.toThrow(BackfillRefused);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("refuses --all-tenants combined with --apply (dry-run only)", async () => {
    const prisma = mockPrisma();
    await expect(
      backfillProductCatalogRows(prisma, { allTenants: true, apply: true }),
    ).rejects.toThrow(/dry-run only/);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("refuses a --live-tenant-override that does not match --tenant", async () => {
    const prisma = mockPrisma();
    await expect(
      backfillProductCatalogRows(prisma, {
        tenantSlug: "acme-live",
        apply: false,
        liveTenantOverride: "someone-else",
      }),
    ).rejects.toThrow(BackfillRefused);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a non-test tenant slug with no override (dry-run too)", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "acme-live" });
    await expect(
      backfillProductCatalogRows(prisma, { tenantSlug: "acme-live", apply: false }),
    ).rejects.toThrow(BackfillRefused);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("refuses an unknown tenant slug", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(
      backfillProductCatalogRows(prisma, { tenantSlug: "nope", apply: false }),
    ).rejects.toThrow(BackfillRefused);
  });

  it("R-030a: no refusal message echoes a tenant slug (stderr may be pasted to the board)", async () => {
    const slug = "acme-live-slug-xyz";
    const refusals: Array<() => Promise<unknown>> = [
      () =>
        backfillProductCatalogRows(mockPrisma(), {
          tenantSlug: slug,
          apply: false,
          liveTenantOverride: "other-slug-xyz",
        }),
      () => {
        const prisma = mockPrisma();
        prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug });
        return backfillProductCatalogRows(prisma, { tenantSlug: slug, apply: false });
      },
      () => {
        const prisma = mockPrisma();
        prisma.tenant.findUnique.mockResolvedValue(null);
        return backfillProductCatalogRows(prisma, { tenantSlug: slug, apply: false });
      },
    ];
    for (const run of refusals) {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BackfillRefused);
      expect((err as Error).message).not.toContain(slug);
      expect((err as Error).message).not.toContain("other-slug-xyz");
    }
  });
});

describe("backfillProductCatalogRows — dry-run makes no write call", () => {
  it("plans rows for a single test tenant without calling createMany", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "test" });
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: "A",
        barcode: "036000291452",
        unitsPerBox: 12,
        imageKeys: [],
        _count: { barcodes: 0, images: 0 },
      },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([]);

    const counts = await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: false });

    expect(counts.mode).toBe("dry-run");
    expect(counts.barcodeRowsPlanned).toBe(2);
    expect(counts.barcodeRowsInserted).toBe(0);
    expect(counts.imageRowsInserted).toBe(0);
    expect(prisma.productBarcode.createMany).not.toHaveBeenCalled();
    expect(prisma.productImage.createMany).not.toHaveBeenCalled();
  });
});

describe("backfillProductCatalogRows — planned counts over a mixed product set", () => {
  it("computes A=2, B=1, C=1, D=0, E=skipped, plus image focal parsing", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "test" });
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: "A",
        barcode: "036000291452",
        unitsPerBox: 12,
        imageKeys: [],
        _count: { barcodes: 0, images: 0 },
      },
      {
        id: "B",
        barcode: "12345678",
        unitsPerBox: 1,
        imageKeys: [],
        _count: { barcodes: 0, images: 0 },
      },
      {
        id: "C",
        barcode: "96385074",
        unitsPerBox: null,
        imageKeys: [],
        _count: { barcodes: 0, images: 0 },
      },
      {
        id: "D",
        barcode: null,
        unitsPerBox: 6,
        imageKeys: [],
        _count: { barcodes: 0, images: 0 },
      },
      {
        id: "E",
        barcode: "036000291452",
        unitsPerBox: 12,
        imageKeys: [],
        _count: { barcodes: 1, images: 0 },
      },
      {
        id: "F",
        barcode: null,
        unitsPerBox: null,
        imageKeys: ["products/F/k1.jpg", "products/F/k2-fp30x70.jpg"],
        _count: { barcodes: 0, images: 0 },
      },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([]);

    const counts = await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: false });

    expect(counts.products).toBe(6);
    // A: BOX+UNIT (2), B: UNIT (1), C: UNIT (1), D: none (0), E: skipped (already has rows)
    expect(counts.barcodeRowsPlanned).toBe(4);
    expect(counts.productsWithBarcodeRowsAlready).toBe(1);
    // F: 2 image rows planned, focal parsed on the second key
    expect(counts.imageRowsPlanned).toBe(2);
  });

  it("apply inserts the planned rows via createMany with skipDuplicates, summing .count", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "test" });
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: "A",
        barcode: "036000291452",
        unitsPerBox: 12,
        imageKeys: ["products/A/k1-fp30x70.jpg"],
        _count: { barcodes: 0, images: 0 },
      },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([]);
    prisma.productBarcode.createMany.mockResolvedValue({ count: 2 });
    prisma.productImage.createMany.mockResolvedValue({ count: 1 });

    const counts = await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: true });

    expect(counts.mode).toBe("apply");
    expect(prisma.productBarcode.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.productImage.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(counts.barcodeRowsInserted).toBe(2);
    expect(counts.imageRowsInserted).toBe(1);
  });

  it("a non-test tenant WITH a matching override still proceeds, warns via stderr when protected", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({
      id: "t1",
      slug: "acme-live",
      status: "ACTIVE",
      deletedAt: null,
      class: "PRODUCTION",
    });
    prisma.tenantSubscription.findUnique.mockResolvedValue({ planKey: "GROWTH" });
    prisma.product.findMany.mockResolvedValueOnce([]);
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const counts = await backfillProductCatalogRows(prisma, {
        tenantSlug: "acme-live",
        apply: false,
        liveTenantOverride: "acme-live",
      });
      expect(counts.tenants).toBe(1);
      expect(
        stderrSpy.mock.calls.some((c) => String(c[0]).includes("protected (paying) tenant")),
      ).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("backfill-product-catalog-rows.ts — T12 source pin (INSERT-ONLY)", () => {
  it("contains no update/upsert/delete call or raw-SQL UPDATE/DELETE text", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "prisma", "backfill-product-catalog-rows.ts"),
      "utf8",
    );
    for (const forbidden of [
      ".update(",
      ".updateMany(",
      ".upsert(",
      ".delete(",
      ".deleteMany(",
      "$executeRaw",
    ]) {
      expect(src).not.toContain(forbidden);
    }
    expect(src).not.toMatch(/\bUPDATE\s/);
    expect(src).not.toMatch(/\bDELETE\s/);
  });
});
