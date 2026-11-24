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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, context?: string) => string;
};

/**
 * P-21 (573): GET /products?ids= is one batch read through the list's where-builder. Real Postgres; two throwaway
 * `qa-*` tenants. I1 (3 ids, 3 rows), I4 (another tenant's id is absent, with no trace), I5 (a deactivated product
 * is returned), I6 (`page` is ignored).
 */
describeDb("products by ids (P-21) (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-p21-a-${run}`, "products-by-ids.db.spec.ts");
  const slugB = assertTestTenant(`qa-p21-b-${run}`, "products-by-ids.db.spec.ts");
  let tenantA: string;
  let tenantB: string;
  let ctx: TenantContextService;
  let appPrisma: PrismaService;
  let products: ProductsService;
  const a: string[] = [];
  let aInactive: string;
  let b: string;

  const mk = (tenantId: string, name: string, isActive = true) =>
    prisma.product.create({
      data: { tenantId, name: `p21-${name}-${run}`, unit: "each", pricePerUnit: 1, isActive },
    });

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
    for (let i = 0; i < 4; i++) a.push((await mk(tenantA, `a${i}`)).id);
    aInactive = (await mk(tenantA, "off", false)).id;
    b = (await mk(tenantB, "b0")).id;

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
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
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

  const read = (tenant: string, query: Record<string, unknown>): Promise<any> =>
    ctx.run(tenant, () => products.findAll(query as any));

  it("I1: 3 ids return exactly those 3 rows", async () => {
    const res = await read(tenantA, { ids: a.slice(0, 3) });
    expect(res.data.map((p: any) => p.id).sort()).toEqual([...a.slice(0, 3)].sort());
    expect(res.meta.total).toBe(3);
  });

  it("I4: tenant B's id, asked as tenant A, is absent and leaves no trace", async () => {
    const res = await read(tenantA, { ids: [a[0], b] });
    expect(res.data.map((p: any) => p.id)).toEqual([a[0]]);
    expect(res.meta.total).toBe(1);
    expect(JSON.stringify(res)).not.toContain(b);
    expect(JSON.stringify(res)).not.toContain(`p21-b0-${run}`);
  });

  it("I4: an id that exists nowhere is absent too, with no error", async () => {
    const res = await read(tenantA, { ids: [randomUUID()] });
    expect(res.data).toEqual([]);
    expect(res.meta.total).toBe(0);
  });

  it("I5: a deactivated product is returned", async () => {
    const res = await read(tenantA, { ids: [aInactive, a[0]] });
    expect(res.data.map((p: any) => p.id).sort()).toEqual([aInactive, a[0]].sort());
  });

  it("I6: page=3 and a small limit still return every match", async () => {
    const res = await read(tenantA, { ids: a, page: 3, limit: 1 });
    expect(res.data.map((p: any) => p.id).sort()).toEqual([...a].sort());
  });
});
