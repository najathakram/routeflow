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
  formatErrorForStderr,
} from "../../prisma/backfill-product-catalog-rows";
import { lockBarcodeCodes, lockProductRow } from "../products/product-catalog-sync";

// F2/F3 (#2728 M1 follow-up, pre-merge BLOCK): apply mode now takes its locks through these two
// helpers (the same ones the app's own writers use) — mocked here so the unit spec can pin call
// ORDER without a real Postgres advisory-lock/row-lock round trip (that proof is the db spec).
jest.mock("../products/product-catalog-sync", () => ({
  lockBarcodeCodes: jest.fn().mockResolvedValue(undefined),
  lockProductRow: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  (lockBarcodeCodes as jest.Mock).mockReset().mockResolvedValue(undefined);
  (lockProductRow as jest.Mock).mockReset().mockResolvedValue(undefined);
});

/**
 * `__tx` is the per-product interactive-transaction client apply mode now opens via
 * `prisma.$transaction(async (tx) => ...)` — exposed on the returned mock so a test can stub/assert
 * against it directly (e.g. `prisma.__tx.product.findUnique.mockResolvedValue(...)`).
 */
function mockPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    product: { findUnique: jest.fn() },
    productBarcode: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    productImage: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
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
    $transaction: jest.fn((fn: any) => fn(tx)),
    __tx: tx,
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

  it("apply inserts the planned rows via createMany (skipDuplicates) inside a per-product transaction, summing .count", async () => {
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
    prisma.__tx.product.findUnique.mockResolvedValue({
      barcode: "036000291452",
      unitsPerBox: 12,
      imageKeys: ["products/A/k1-fp30x70.jpg"],
      tenantId: "t1",
      _count: { barcodes: 0, images: 0 },
    });
    prisma.__tx.productBarcode.createMany.mockResolvedValue({ count: 2 });
    prisma.__tx.productImage.createMany.mockResolvedValue({ count: 1 });

    const counts = await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: true });

    expect(counts.mode).toBe("apply");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.productBarcode.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.__tx.productImage.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(counts.barcodeRowsInserted).toBe(2);
    expect(counts.imageRowsInserted).toBe(1);
    // Never inserted through the outer, unlocked (non-tx) client.
    expect(prisma.productBarcode.createMany).not.toHaveBeenCalled();
    expect(prisma.productImage.createMany).not.toHaveBeenCalled();
  });

  it("a barcode changed between the page read and the row lock: its barcode rows are skipped this run (no lock-order inversion), images still mirror", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "test" });
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: "A",
        barcode: "036000291452",
        unitsPerBox: 12,
        imageKeys: ["products/A/k1.jpg"],
        _count: { barcodes: 0, images: 0 },
      },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([]);
    prisma.__tx.product.findUnique.mockResolvedValue({
      barcode: "4006381333931",
      unitsPerBox: 12,
      imageKeys: ["products/A/k1.jpg"],
      tenantId: "t1",
      _count: { barcodes: 0, images: 0 },
    });
    prisma.__tx.productImage.createMany.mockResolvedValue({ count: 1 });

    const counts = await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: true });

    expect(prisma.__tx.productBarcode.createMany).not.toHaveBeenCalled();
    expect(counts.barcodeRowsInserted).toBe(0);
    expect(counts.imageRowsInserted).toBe(1);
    // SA-572g(3): this skip (lock-order inversion avoidance) is now counted, not silent.
    expect(counts.barcodeSkippedCodeChanged).toBe(1);
  });

  // #2728 M1 follow-up (SA-572f, amendment 1 — FINAL): the backfill's image planning uses
  // mirrorableImageKeys too — a duplicate legacy key plans/inserts exactly ONE row.
  it("a duplicate imageKeys entry plans/inserts exactly 1 image row (mirrorableImageKeys dedup)", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "test" });
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: "H",
        barcode: null,
        unitsPerBox: null,
        imageKeys: ["products/H/k1.jpg", "products/H/k1.jpg"],
        _count: { barcodes: 0, images: 0 },
      },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([]);
    prisma.__tx.product.findUnique.mockResolvedValue({
      barcode: null,
      unitsPerBox: null,
      imageKeys: ["products/H/k1.jpg", "products/H/k1.jpg"],
      tenantId: "t1",
      _count: { barcodes: 0, images: 0 },
    });
    prisma.__tx.productImage.createMany.mockResolvedValue({ count: 1 });

    const counts = await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: true });

    expect(counts.imageRowsPlanned).toBe(1);
    expect(prisma.__tx.productImage.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([expect.anything()]) }),
    );
    const data = (prisma.__tx.productImage.createMany.mock.calls[0][0] as { data: unknown[] }).data;
    expect(data).toHaveLength(1);
  });

  // A key another product's row already holds is SKIPPED (per key), never inserted, never throws —
  // the backfill is INSERT-ONLY so this is simply an omission, not a delete.
  it("a legacy image key another product's row already holds is skipped, not inserted", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "test" });
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: "I",
        barcode: null,
        unitsPerBox: null,
        imageKeys: ["products/I/k1.jpg", "products/I/k2.jpg"],
        _count: { barcodes: 0, images: 0 },
      },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([]);
    prisma.__tx.product.findUnique.mockResolvedValue({
      barcode: null,
      unitsPerBox: null,
      imageKeys: ["products/I/k1.jpg", "products/I/k2.jpg"],
      tenantId: "t1",
      _count: { barcodes: 0, images: 0 },
    });
    prisma.__tx.productImage.findMany.mockResolvedValue([{ storageKey: "products/I/k1.jpg" }]);
    prisma.__tx.productImage.createMany.mockResolvedValue({ count: 1 });

    const counts = await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: true });

    expect(counts.imageRowsPlanned).toBe(1);
    const data = (prisma.__tx.productImage.createMany.mock.calls[0][0] as { data: unknown[] }).data;
    expect(data).toHaveLength(1);
    expect((data[0] as { storageKey: string }).storageKey).toBe("products/I/k2.jpg");
  });

  it("F2/F3: locks in the app's order — code lock, row lock, THEN the fresh read, THEN createMany", async () => {
    const order: string[] = [];
    (lockBarcodeCodes as jest.Mock).mockImplementation(async () => {
      order.push("lockBarcodeCodes");
    });
    (lockProductRow as jest.Mock).mockImplementation(async () => {
      order.push("lockProductRow");
    });
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "test" });
    prisma.product.findMany.mockResolvedValueOnce([
      { id: "A", barcode: "X", unitsPerBox: 1, imageKeys: [], _count: { barcodes: 0, images: 0 } },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([]);
    prisma.__tx.product.findUnique.mockImplementation(async () => {
      order.push("findUnique");
      return {
        barcode: "X",
        unitsPerBox: 1,
        imageKeys: [],
        tenantId: "t1",
        _count: { barcodes: 0, images: 0 },
      };
    });
    prisma.__tx.productBarcode.createMany.mockImplementation(async () => {
      order.push("createMany");
      return { count: 1 };
    });

    await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: true });

    expect(order).toEqual(["lockBarcodeCodes", "lockProductRow", "findUnique", "createMany"]);
  });

  it("F2/F3: a product whose FRESH read shows barcode rows already present (concurrent writer) inserts nothing", async () => {
    const prisma = mockPrisma();
    prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "test" });
    prisma.product.findMany.mockResolvedValueOnce([
      { id: "A", barcode: "X", unitsPerBox: 1, imageKeys: [], _count: { barcodes: 0, images: 0 } },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([]);
    // Between the page read and this product's own transaction, the app's own dual-write sync
    // already inserted rows for it (e.g. a concurrent products.service.ts update()).
    prisma.__tx.product.findUnique.mockResolvedValue({
      barcode: "X",
      unitsPerBox: 1,
      imageKeys: [],
      tenantId: "t1",
      _count: { barcodes: 1, images: 0 },
    });

    const counts = await backfillProductCatalogRows(prisma, { tenantSlug: "test", apply: true });

    expect(prisma.__tx.productBarcode.createMany).not.toHaveBeenCalled();
    expect(counts.barcodeRowsPlanned).toBe(0);
    expect(counts.barcodeRowsInserted).toBe(0);
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
        protectedSlugs: new Set<string>(),
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
