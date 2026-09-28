/**
 * T9 (#2728 M1 build-plan) — DB-lane proof for the barcode-by-level / photo-row dual write
 * (SA-572b/c). Real Postgres, throwaway `qa-*` tenants.
 *
 * WRITTEN, NOT RUN by this package (P3): the DB lane is F2's to run (`npm run local:test:db`),
 * and this worktree makes no DB connection. Collected only by `jest.db.config.js`
 * (`.db.spec.ts$`). `requireLocalDatabaseUrl()` refuses any non-local host; every tenant is a
 * throwaway `qa-2728-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes exactly
 * the tenants this run created (Product cascades to ProductBarcode/ProductImage; StockMovement/
 * StockLot/User are cleared first since Product does not cascade to them).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-2728-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "products-dual-write.db.spec.ts",
  );
};

describeDb("#2728 M1 catalog dual write — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: ProductsService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest
              .fn()
              .mockImplementation((keys: string[]) =>
                Promise.resolve(keys.map(() => "http://mock-url")),
              ),
            upload: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    // ProductBarcode/ProductImage cascade on Product delete (schema onDelete: Cascade).
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `2728 M1 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  it("create(upb 12, code) -> Product.barcode = code AND 2 ProductBarcode rows (BOX ENTERED, UNIT COPIED)", async () => {
    const tenantId = await seedTenant("create-boxed");
    const product = await inTenant(tenantId, () =>
      service.create({
        name: "Case Widget",
        unit: "case",
        pricePerUnit: "10.00",
        barcode: "036000291452",
        unitsPerBox: 12,
      } as any),
    );
    const fresh = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(fresh.barcode).toBe("036000291452");
    const rows = await prisma.productBarcode.findMany({
      where: { tenantId, productId: product.id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.level === "BOX")?.origin).toBe("ENTERED");
    expect(rows.find((r) => r.level === "UNIT")?.origin).toBe("COPIED");
  });

  it("update(code2) -> rows follow the new code; the old code is gone", async () => {
    const tenantId = await seedTenant("update-follow");
    const product = await inTenant(tenantId, () =>
      service.create({
        name: "Single Widget",
        unit: "each",
        pricePerUnit: "1.00",
        barcode: "111",
        unitsPerBox: 1,
      } as any),
    );
    await inTenant(tenantId, () => service.update(product.id, { barcode: "222" } as any));
    const rows = await prisma.productBarcode.findMany({
      where: { tenantId, productId: product.id },
    });
    expect(rows.map((r) => r.code)).toEqual(["222"]);
    const oldCodeRows = await prisma.productBarcode.findMany({ where: { tenantId, code: "111" } });
    expect(oldCodeRows).toHaveLength(0);
  });

  it("SA-572c RACE: two concurrent creates of one NEW code on two products -> exactly one succeeds, one gets 409 BARCODE_TAKEN (never a raw error)", async () => {
    const tenantId = await seedTenant("race");
    const attempt = (name: string) =>
      inTenant(tenantId, () =>
        service.create({
          name,
          unit: "each",
          pricePerUnit: "1.00",
          barcode: "999888777",
          unitsPerBox: 1,
        } as any),
      );
    const results = await Promise.allSettled([attempt("Racer A"), attempt("Racer B")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(typeof reason.getResponse).toBe("function");
    expect(reason.getResponse()).toMatchObject({ code: "BARCODE_TAKEN" });
  });

  it("product B update to a code A already holds -> 409 BARCODE_TAKEN; B's legacy barcode unchanged (tx rolled back)", async () => {
    const tenantId = await seedTenant("cross-conflict");
    const a = await inTenant(tenantId, () =>
      service.create({ name: "A", unit: "each", pricePerUnit: "1.00", barcode: "AAA111" } as any),
    );
    const b = await inTenant(tenantId, () =>
      service.create({ name: "B", unit: "each", pricePerUnit: "1.00", barcode: "BBB222" } as any),
    );
    await expect(
      inTenant(tenantId, () => service.update(b.id, { barcode: "AAA111" } as any)),
    ).rejects.toMatchObject({ getResponse: expect.any(Function) });
    const freshB = await prisma.product.findUniqueOrThrow({ where: { id: b.id } });
    expect(freshB.barcode).toBe("BBB222");
    void a;
  });

  it("image upload -> a ProductImage row with sortOrder/focal; delete -> the row gone", async () => {
    const tenantId = await seedTenant("images");
    const product = await inTenant(tenantId, () =>
      service.create({ name: "Photo Widget", unit: "each", pricePerUnit: "1.00" } as any),
    );
    const { key } = await inTenant(tenantId, () =>
      service.uploadImage(product.id, Buffer.from("fake"), "a.jpg", "image/jpeg", { x: 30, y: 70 }),
    );
    const rowsAfterUpload = await prisma.productImage.findMany({
      where: { tenantId, productId: product.id },
    });
    expect(rowsAfterUpload).toHaveLength(1);
    expect(rowsAfterUpload[0].sortOrder).toBe(0);
    expect(rowsAfterUpload[0].focalX).toBe(30);
    expect(rowsAfterUpload[0].focalY).toBe(70);

    await inTenant(tenantId, () => service.deleteImage(product.id, key));
    const rowsAfterDelete = await prisma.productImage.findMany({
      where: { tenantId, productId: product.id },
    });
    expect(rowsAfterDelete).toHaveLength(0);
  });

  it("findOne shape: rows present vs. after the rows are deleted (origin ROW/COPIED/ENTERED vs LEGACY)", async () => {
    const tenantId = await seedTenant("read-shape");
    const product = await inTenant(tenantId, () =>
      service.create({
        name: "Shape Widget",
        unit: "case",
        pricePerUnit: "5.00",
        barcode: "555444333",
        unitsPerBox: 6,
      } as any),
    );
    const withRows = await inTenant(tenantId, () => service.findOne(product.id));
    expect((withRows as any).barcodes.length).toBe(2);
    expect((withRows as any).barcodes.every((b: any) => b.origin !== "LEGACY")).toBe(true);

    await prisma.productBarcode.deleteMany({ where: { tenantId, productId: product.id } });
    const withoutRows = await inTenant(tenantId, () => service.findOne(product.id));
    expect((withoutRows as any).barcodes.length).toBe(2);
    expect((withoutRows as any).barcodes.every((b: any) => b.origin === "LEGACY")).toBe(true);
    // Same shape, same keys, either way.
    expect(Object.keys(withRows).sort()).toEqual(Object.keys(withoutRows).sort());
  });
});
