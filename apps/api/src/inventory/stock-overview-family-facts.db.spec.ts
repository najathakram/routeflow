import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, ProductKind, TenantClass, TenantStatus } from "@prisma/client";
import { Test, TestingModule } from "@nestjs/testing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { InventoryService } from "./inventory.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { ProductsService } from "../products/products.service";
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
 * W-1299: the Inventory Stock tab used to read the WHOLE catalog a second time
 * (`GET /products?includeVariants=true&limit=0`) for five facts per product: the kind, the variant name,
 * the parent id, the family name and "has variants". `GET /inventory/overview` carries them now.
 *
 * This is the same-answer proof on real Postgres: for every product of a tenant, the stock overview gives
 * exactly what the catalog read gave. The rows are the cases where the two could drift:
 *   - a family with an active and an inactive variant (has variants);
 *   - a family whose ONLY variant is inactive (does not: only active variants count);
 *   - a variant, active and inactive (family name follows the parent);
 *   - a variant whose parent sits in ANOTHER tenant (B1211: that parent is never followed, and the
 *     other tenant's family does not count this variant);
 *   - standalone products, active and inactive.
 * Two throwaway `qa-*` tenants.
 */
describeDb("stock overview carries the catalog's family facts (W-1299) (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-w1299-a-${run}`, "stock-overview-family-facts.db.spec.ts");
  const slugB = assertTestTenant(`qa-w1299-b-${run}`, "stock-overview-family-facts.db.spec.ts");
  let tenantA: string;
  let tenantB: string;
  let ctx: TenantContextService;
  let appPrisma: PrismaService;
  let products: ProductsService;
  let inventory: InventoryService;
  const ids: Record<string, string> = {};

  const mk = async (
    tenantId: string,
    key: string,
    extra: {
      kind?: ProductKind;
      parentKey?: string;
      variantName?: string;
      isActive?: boolean;
      name?: string;
    } = {},
  ) => {
    const p = await prisma.product.create({
      data: {
        tenantId,
        name: extra.name ?? `w1299-${key}-${run}`,
        unit: "each",
        pricePerUnit: 1,
        currentStock: 3,
        kind: extra.kind ?? ProductKind.STANDARD,
        isActive: extra.isActive ?? true,
        variantName: extra.variantName ?? null,
        parentProductId: extra.parentKey ? ids[extra.parentKey] : null,
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

    // Tenant A.
    await mk(tenantA, "fam", { kind: ProductKind.FAMILY, name: `Acme Vape ${run}` });
    await mk(tenantA, "fam-blue", {
      kind: ProductKind.VARIANT,
      parentKey: "fam",
      variantName: "Blueberry",
      name: "Blueberry",
    });
    await mk(tenantA, "fam-mint-off", {
      kind: ProductKind.VARIANT,
      parentKey: "fam",
      variantName: "Mint",
      name: "Mint",
      isActive: false,
    });
    await mk(tenantA, "fam-quiet", { kind: ProductKind.FAMILY, name: `Acme Quiet ${run}` });
    await mk(tenantA, "fam-quiet-off", {
      kind: ProductKind.VARIANT,
      parentKey: "fam-quiet",
      variantName: "Plain",
      name: "Plain",
      isActive: false,
    });
    await mk(tenantA, "solo");
    await mk(tenantA, "solo-off", { isActive: false });

    // Tenant B: a family whose only "variant" is a tenant A row pointing across tenants.
    await mk(tenantB, "b-fam", { kind: ProductKind.FAMILY, name: `Acme Other ${run}` });
    await mk(tenantB, "b-solo");
    await mk(tenantA, "a-cross", {
      kind: ProductKind.VARIANT,
      parentKey: "b-fam",
      variantName: "Stray",
      name: "Stray",
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        InventoryService,
        {
          provide: PrismaService,
          useFactory: () => {
            ctx = new TenantContextService();
            appPrisma = new PrismaService(ctx);
            return appPrisma;
          },
        },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
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
    inventory = module.get(InventoryService);
    await appPrisma.$connect();
  }, 120_000);

  afterAll(async () => {
    // Variants first: a variant's parent may sit in the other tenant.
    await prisma.product.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] }, parentProductId: { not: null } },
    });
    await prisma.product.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
    await pool.end().catch(() => undefined);
  });

  type Facts = {
    kind: string;
    variantName: string | null;
    parentProductId: string | null;
    parentName: string | null;
    hasVariants: boolean;
  };

  /** What the Stock tab used to derive from the whole-catalog read (the code this change removed). */
  const catalogFacts = async (tenantId: string): Promise<Map<string, Facts>> => {
    const res: any = await ctx.run(tenantId, () =>
      products.findAll({ includeVariants: true, limit: 0 } as any),
    );
    return new Map(
      res.data.map((p: any) => [
        p.id,
        {
          kind: p.kind,
          variantName: p.variantName ?? null,
          parentProductId: p.parentProductId ?? null,
          parentName: p.parent?.name ?? null,
          hasVariants: (p.variants?.length ?? 0) > 0,
        },
      ]),
    );
  };

  /** What the Stock tab reads now. */
  const overviewFacts = async (tenantId: string): Promise<Map<string, Facts>> => {
    const rows: any[] = await ctx.run(tenantId, () => inventory.getStockOverview());
    return new Map(
      rows.map((r) => [
        r.id,
        {
          kind: r.kind,
          variantName: r.variantName,
          parentProductId: r.parentProductId,
          parentName: r.parent?.name ?? null,
          hasVariants: r.hasVariants,
        },
      ]),
    );
  };

  const sorted = (m: Map<string, Facts>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));

  it.each([
    ["tenant A", () => tenantA, 8],
    ["tenant B", () => tenantB, 2],
  ])(
    "%s: the overview gives the same five facts as the catalog read, for every product",
    async (_label, tenant, count) => {
      const before = await catalogFacts(tenant());
      const after = await overviewFacts(tenant());

      expect(after.size).toBe(count);
      expect(sorted(after)).toEqual(sorted(before));
    },
  );

  it("a family has variants only while one of them is active", async () => {
    const facts = await overviewFacts(tenantA);

    expect(facts.get(ids["fam"])?.hasVariants).toBe(true);
    expect(facts.get(ids["fam-quiet"])?.hasVariants).toBe(false);
    // Still a FAMILY by kind: Create purchase order drops it whether or not a variant is active.
    expect(facts.get(ids["fam-quiet"])?.kind).toBe("FAMILY");
    expect(facts.get(ids["solo"])?.hasVariants).toBe(false);
  });

  it("a variant carries its variant name, its parent id and its family's name, active or not", async () => {
    const facts = await overviewFacts(tenantA);

    expect(facts.get(ids["fam-blue"])).toEqual({
      kind: "VARIANT",
      variantName: "Blueberry",
      parentProductId: ids["fam"],
      parentName: `Acme Vape ${run}`,
      hasVariants: false,
    });
    expect(facts.get(ids["fam-mint-off"])?.parentName).toBe(`Acme Vape ${run}`);
  });

  it("a parent in another tenant is never followed, and never counts the stray variant (B1211)", async () => {
    const a = await overviewFacts(tenantA);
    const b = await overviewFacts(tenantB);

    expect(a.get(ids["a-cross"])).toEqual({
      kind: "VARIANT",
      variantName: "Stray",
      parentProductId: ids["b-fam"],
      parentName: null,
      hasVariants: false,
    });
    expect(b.get(ids["b-fam"])?.hasVariants).toBe(false);
    expect(b.has(ids["a-cross"])).toBe(false);
  });

  it("the parent summary sent to the browser is the name only", async () => {
    const rows: any[] = await ctx.run(tenantA, () => inventory.getStockOverview());
    const variant = rows.find((r) => r.id === ids["fam-blue"]);

    expect(variant.parent).toEqual({ name: `Acme Vape ${run}` });
    expect(variant).not.toHaveProperty("_count");
  });
});
