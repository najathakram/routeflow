import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { LOW_STOCK_DEFAULT } from "@routeflow/types";
import { buildProductListWhere } from "./product-list-where";
import { LOW_STOCK_ID_CAP, lowStockProductIds } from "./low-stock-ids";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, context?: string) => string;
};

/**
 * SA-1002 (W-925): the Low / In-stock list filter is ONE rule, `isActive AND stock <= COALESCE(reorderPoint, 5)`, read through
 * a tenant-scoped `Prisma.sql` prefetch for the list, the ids and the CSV. Real Postgres; two throwaway `qa-*` tenants.
 */
describeDb("products Low-stock filter, one rule (W-925) (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-w925-a-${run}`, "low-stock.db.spec.ts");
  const slugB = assertTestTenant(`qa-w925-b-${run}`, "low-stock.db.spec.ts");
  let tenantA: string;
  let tenantB: string;
  let ctx: TenantContextService;
  let appPrisma: PrismaService;
  let products: ProductsService;
  const ids: Record<string, string> = {};

  const mk = async (
    tenantId: string,
    key: string,
    stock: number,
    reorderPoint: number | null,
    isActive = true,
  ) => {
    const p = await prisma.product.create({
      data: {
        tenantId,
        name: `w925-${key}-${run}`,
        unit: "each",
        pricePerUnit: 1,
        currentStock: stock,
        reorderPoint,
        isActive,
      },
    });
    ids[key] = p.id;
  };

  beforeAll(async () => {
    tenantA = (
      await prisma.tenant.create({
        data: { slug: slugA, name: slugA, class: TenantClass.TEST, status: TenantStatus.ACTIVE },
      })
    ).id;
    tenantB = (
      await prisma.tenant.create({
        data: { slug: slugB, name: slugB, class: TenantClass.TEST, status: TenantStatus.ACTIVE },
      })
    ).id;
    await mk(tenantA, "r1-10-8", 8, 10); // row 1: above the old 5, within its own point
    await mk(tenantA, "r2-null-8", 8, null); // row 2: guard
    await mk(tenantA, "r3-null-5", 5, null); // row 3: the default boundary, inclusive
    await mk(tenantA, "r4-3-4", 4, 3); // row 4: the other direction (4 <= 5 was LOW, 4 > 3 is not)
    await mk(tenantA, "r5-null-0", 0, null); // row 5: zero stays LOW
    await mk(tenantA, "r7-10-10", 10, 10); // row 7: stock == reorderPoint is IN
    await mk(tenantA, "r8-inactive", 1, null, false); // inactive is never LOW
    await mk(tenantB, "b-10-8", 8, 10); // row 6: the other tenant's low product

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        {
          provide: PrismaService,
          useFactory: () => {
            ctx = new TenantContextService();
            appPrisma = new PrismaService(ctx);
            return appPrisma;
          },
        },
        {
          provide: StorageService,
          useValue: { presignedUrl: jest.fn(), presignedUrls: jest.fn().mockResolvedValue([]) },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    products = module.get(ProductsService);
    await appPrisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await pool.end().catch(() => undefined);
  });

  const lowIds = () => ["r1-10-8", "r3-null-5", "r5-null-0", "r7-10-10"].map((k) => ids[k]);
  const lowKeys = ["r1-10-8", "r3-null-5", "r5-null-0", "r7-10-10"];
  const names = (rows: { name: string }[]) =>
    rows.map((r) => r.name.replace(`w925-`, "").replace(`-${run}`, "")).sort();

  it("the list: LOW is stock <= (reorderPoint ?? 5), inclusive, zero included, inactive and other tenants out (rows 1-7)", async () => {
    const res: any = await ctx.run(tenantA, () =>
      products.findAll({ stockStatus: "LOW", limit: 100 } as any),
    );
    expect(names(res.data)).toEqual([...lowKeys].sort());
    expect(res.meta.total).toBe(lowKeys.length);
    expect(lowIds().length).toBe(lowKeys.length);
  });

  it("IN_STOCK is the complement on the same rule (active products only)", async () => {
    const res: any = await ctx.run(tenantA, () =>
      products.findAll({ stockStatus: "IN_STOCK", limit: 100 } as any),
    );
    expect(names(res.data)).toEqual(["r2-null-8", "r4-3-4"].sort());
  });

  it("ids: the same rule (row 1 included, row 6 never)", async () => {
    const res: any = await ctx.run(tenantA, () => products.findIds({ stockStatus: "LOW" } as any));
    expect([...res.ids].sort()).toEqual([...lowIds()].sort());
    expect(res.ids).not.toContain(ids["b-10-8"]);
  });

  it("CSV: the export's where (the same builder and prefetch) matches the same rows", async () => {
    const rows = await ctx.run(tenantA, async () => {
      const lowStockIds = await lowStockProductIds(appPrisma);
      const where = buildProductListWhere({ stockStatus: "LOW" } as any, { lowStockIds });
      return appPrisma.forTenant().product.findMany({ where, select: { id: true } });
    });
    expect(rows.map((r: any) => r.id).sort()).toEqual([...lowIds()].sort());
  });

  it("a second tenant's low product never appears in the first tenant's prefetch", async () => {
    const a = await ctx.run(tenantA, () => lowStockProductIds(appPrisma));
    const b = await ctx.run(tenantB, () => lowStockProductIds(appPrisma));
    expect(a).not.toContain(ids["b-10-8"]);
    expect(b).toEqual([ids["b-10-8"]]);
  });

  it("the default is the constant, not a second literal", () => {
    expect(LOW_STOCK_DEFAULT).toBe(5);
    expect(LOW_STOCK_ID_CAP).toBe(20_000);
  });
});
