/**
 * DB-lane spec for prisma/backfill-product-catalog-rows.ts's `backfillProductCatalogRows(prisma,
 * opts)` (#2728 M1, SA-572a/b, T11) — real Postgres. Collected only by `jest.db.config.js`
 * (`.db.spec.ts$`), run via `npm run local:test:db`. `requireLocalDatabaseUrl()` refuses any
 * non-local host.
 *
 * AUTHORED WITHOUT A DATABASE (this lane runs no local Postgres): typechecked, NOT executed here.
 * F2 runs it at the PR sha; do not treat it as passing until that run is posted.
 *
 * Fixture (one throwaway `qa-*` tenant, assertTestTenant-approved):
 *   A — unitsPerBox 12, a code            → plans BOX ENTERED + UNIT COPIED (2 rows)
 *   B — unitsPerBox 1,  a code            → plans one UNIT ENTERED row (1 row)
 *   C — unitsPerBox null, a code          → plans one UNIT ENTERED row (1 row; null ~ 1)
 *   D — no code                           → plans nothing (0 rows)
 *   E — already has ONE ProductBarcode row → skipped entirely (idempotency guard, not re-planned)
 *   F — two imageKeys, the second with a `-fp30x70` focal suffix → 2 ProductImage rows
 *
 * Plus a SECOND, non-test-slug tenant (class PRODUCTION, created directly — never a real tenant)
 * to prove the live-tenant refusal fires before any row is written, with and without a mismatched
 * `--live-tenant-override`.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  backfillProductCatalogRows,
  BackfillRefused,
} from "../../prisma/backfill-product-catalog-rows";
import { syncProductBarcodesFromLegacy } from "../products/product-catalog-sync";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, context?: string) => string;
};

describeDb("backfill-product-catalog-rows backfillProductCatalogRows() (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const run = randomUUID().slice(0, 8);
  const testSlug = assertTestTenant(
    `qa-2728-backfill-${run}`,
    "backfill-product-catalog-rows.db.spec.ts",
  );
  let testTenantId: string;
  const productIds: Record<string, string> = {};

  // The non-test (PRODUCTION-class, non-qa/e2e/ux-audit slug) fixture tenant — created directly in
  // this throwaway local DB ONLY to prove the refusal path; never a real tenant.
  const liveSlug = `acme-live-2728-${run}`;
  let liveTenantId: string;

  async function seedCode(): Promise<string> {
    // Unique EAN-13-shaped codes per run so re-runs of this file never collide on
    // `@@unique([tenantId, code, level])`.
    return `2${run}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(4, "0")}`
      .padEnd(13, "0")
      .slice(0, 13);
  }

  beforeAll(async () => {
    const testTenant = await prisma.tenant.create({
      data: {
        slug: testSlug,
        name: testSlug,
        class: TenantClass.TEST,
        status: TenantStatus.ACTIVE,
      },
    });
    testTenantId = testTenant.id;

    const liveTenant = await prisma.tenant.create({
      data: {
        slug: liveSlug,
        name: liveSlug,
        class: TenantClass.PRODUCTION,
        status: TenantStatus.ACTIVE,
      },
    });
    liveTenantId = liveTenant.id;

    const codeA = await seedCode();
    const codeB = await seedCode();
    const codeC = await seedCode();

    const base = {
      tenantId: testTenantId,
      unit: "case",
      pricePerUnit: 10,
    };

    const a = await prisma.product.create({
      data: { ...base, name: `A ${run}`, barcode: codeA, unitsPerBox: 12 },
    });
    productIds.A = a.id;

    const b = await prisma.product.create({
      data: { ...base, name: `B ${run}`, barcode: codeB, unitsPerBox: 1 },
    });
    productIds.B = b.id;

    const c = await prisma.product.create({
      data: { ...base, name: `C ${run}`, barcode: codeC, unitsPerBox: null },
    });
    productIds.C = c.id;

    const d = await prisma.product.create({
      data: { ...base, name: `D ${run}`, barcode: null, unitsPerBox: 4 },
    });
    productIds.D = d.id;

    const codeE = await seedCode();
    const e = await prisma.product.create({
      data: { ...base, name: `E ${run}`, barcode: codeE, unitsPerBox: 1 },
    });
    productIds.E = e.id;
    await prisma.productBarcode.create({
      data: {
        tenantId: testTenantId,
        productId: e.id,
        code: codeE,
        symbology: "CODE128",
        level: "UNIT",
        origin: "ENTERED",
        primaryFor: "UNIT",
      },
    });

    const f = await prisma.product.create({
      data: {
        ...base,
        name: `F ${run}`,
        barcode: null,
        unitsPerBox: null,
        imageKeys: [`products/${run}-F/k1.jpg`, `products/${run}-F/k2-fp30x70.jpg`],
      },
    });
    productIds.F = f.id;
  });

  afterAll(async () => {
    const ids = Object.values(productIds);
    if (ids.length) {
      await prisma.productBarcode.deleteMany({ where: { productId: { in: ids } } });
      await prisma.productImage.deleteMany({ where: { productId: { in: ids } } });
      await prisma.product.deleteMany({ where: { id: { in: ids } } });
    }
    if (testTenantId) await prisma.tenant.delete({ where: { id: testTenantId } }).catch(() => {});
    if (liveTenantId) await prisma.tenant.delete({ where: { id: liveTenantId } }).catch(() => {});
    await prisma.$disconnect();
    await pool.end();
  });

  it("dry run: plans the expected counts and writes NOTHING", async () => {
    const counts = await backfillProductCatalogRows(prisma, {
      tenantSlug: testSlug,
      apply: false,
    });

    expect(counts.mode).toBe("dry-run");
    expect(counts.barcodeRowsPlanned).toBe(4); // A(2) + B(1) + C(1); D(0), E skipped
    expect(counts.imageRowsPlanned).toBe(2); // F
    expect(counts.barcodeRowsInserted).toBe(0);
    expect(counts.imageRowsInserted).toBe(0);

    const barcodeRows = await prisma.productBarcode.count({
      where: { productId: { in: Object.values(productIds) } },
    });
    // Only E's pre-existing row — nothing else was written.
    expect(barcodeRows).toBe(1);
    const imageRows = await prisma.productImage.count({
      where: { productId: { in: Object.values(productIds) } },
    });
    expect(imageRows).toBe(0);
  });

  it("apply: inserts exactly the planned rows, per-product, and leaves E untouched", async () => {
    const counts = await backfillProductCatalogRows(prisma, {
      tenantSlug: testSlug,
      apply: true,
    });

    expect(counts.mode).toBe("apply");
    expect(counts.barcodeRowsInserted).toBe(4);
    expect(counts.imageRowsInserted).toBe(2);

    const aRows = await prisma.productBarcode.findMany({ where: { productId: productIds.A } });
    expect(aRows).toHaveLength(2);
    expect(aRows.find((r) => r.level === "BOX")).toMatchObject({
      origin: "ENTERED",
      primaryFor: "BOX",
    });
    expect(aRows.find((r) => r.level === "UNIT")).toMatchObject({
      origin: "COPIED",
      copiedFromLevel: "BOX",
      primaryFor: "UNIT",
    });

    const bRows = await prisma.productBarcode.findMany({ where: { productId: productIds.B } });
    expect(bRows).toHaveLength(1);
    expect(bRows[0]).toMatchObject({ level: "UNIT", origin: "ENTERED", primaryFor: "UNIT" });

    const cRows = await prisma.productBarcode.findMany({ where: { productId: productIds.C } });
    expect(cRows).toHaveLength(1);
    expect(cRows[0]).toMatchObject({ level: "UNIT", origin: "ENTERED", primaryFor: "UNIT" });

    const dRows = await prisma.productBarcode.findMany({ where: { productId: productIds.D } });
    expect(dRows).toHaveLength(0);

    // E still has exactly its own pre-existing row — never touched, never duplicated.
    const eRows = await prisma.productBarcode.findMany({ where: { productId: productIds.E } });
    expect(eRows).toHaveLength(1);

    const fRows = await prisma.productImage.findMany({
      where: { productId: productIds.F },
      orderBy: { sortOrder: "asc" },
    });
    expect(fRows).toHaveLength(2);
    expect(fRows[0]).toMatchObject({ sortOrder: 0, isPrimary: true, focalX: null, focalY: null });
    expect(fRows[1]).toMatchObject({ sortOrder: 1, isPrimary: false, focalX: 30, focalY: 70 });
  });

  it("re-run after apply is a true no-op: 0 inserted, row counts unchanged", async () => {
    const before = {
      barcodes: await prisma.productBarcode.count({
        where: { productId: { in: Object.values(productIds) } },
      }),
      images: await prisma.productImage.count({
        where: { productId: { in: Object.values(productIds) } },
      }),
    };

    const counts = await backfillProductCatalogRows(prisma, {
      tenantSlug: testSlug,
      apply: true,
    });

    expect(counts.barcodeRowsInserted).toBe(0);
    expect(counts.imageRowsInserted).toBe(0);

    const after = {
      barcodes: await prisma.productBarcode.count({
        where: { productId: { in: Object.values(productIds) } },
      }),
      images: await prisma.productImage.count({
        where: { productId: { in: Object.values(productIds) } },
      }),
    };
    expect(after).toEqual(before);
  });

  // F2/F3 (#2728 M1 follow-up, pre-merge BLOCK): a product synced by the app's OWN dual-write
  // writer (the same syncProductBarcodesFromLegacy call products.service.ts update() makes, in its
  // own transaction) between the backfill's page read and this product's per-product transaction
  // must be left exactly as the app wrote it — the fresh re-read inside the lock, not the stale
  // page-read snapshot, is what makes this safe (0 extra inserted, rows still equal the plan).
  it("apply: a product synced by a concurrent app-writer before backfill's per-product tx reaches it is left untouched (0 extra inserts)", async () => {
    const codeG = await seedCode();
    const g = await prisma.product.create({
      data: {
        tenantId: testTenantId,
        unit: "case",
        pricePerUnit: 10,
        name: `G ${run}`,
        barcode: codeG,
        unitsPerBox: 1,
      },
    });
    productIds.G = g.id;

    // Simulate the app's own dual-write sync (products.service.ts update()'s pattern) racing ahead
    // of the backfill for this one product.
    await prisma.$transaction(async (tx) => {
      await syncProductBarcodesFromLegacy(tx, {
        tenantId: testTenantId,
        productId: g.id,
        barcode: codeG,
        unitsPerBox: 1,
      });
    });
    const before = await prisma.productBarcode.count({ where: { productId: g.id } });
    expect(before).toBe(1); // UNIT ENTERED (upb 1)

    await backfillProductCatalogRows(prisma, { tenantSlug: testSlug, apply: true });

    const rows = await prisma.productBarcode.findMany({ where: { productId: g.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      level: "UNIT",
      origin: "ENTERED",
      primaryFor: "UNIT",
      code: codeG,
    });
  });

  it("refuses a non-test (LIVE) tenant before any row is written", async () => {
    const before = await prisma.productBarcode.count({ where: { tenantId: liveTenantId } });

    await expect(
      backfillProductCatalogRows(prisma, { tenantSlug: liveSlug, apply: false }),
    ).rejects.toThrow(BackfillRefused);
    await expect(
      backfillProductCatalogRows(prisma, { tenantSlug: liveSlug, apply: true }),
    ).rejects.toThrow(BackfillRefused);

    const after = await prisma.productBarcode.count({ where: { tenantId: liveTenantId } });
    expect(after).toBe(before);
  });

  it("refuses when the live-tenant override names a DIFFERENT slug", async () => {
    await expect(
      backfillProductCatalogRows(prisma, {
        tenantSlug: liveSlug,
        apply: true,
        liveTenantOverride: `not-${liveSlug}`,
      }),
    ).rejects.toThrow(BackfillRefused);

    const rows = await prisma.productBarcode.count({ where: { tenantId: liveTenantId } });
    expect(rows).toBe(0);
  });
});
