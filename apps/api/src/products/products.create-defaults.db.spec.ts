/**
 * S4 (units-and-pricing) — DB-lane proof of the new-product data rules under flag.units_prices_v2.
 * Real Postgres, throwaway `qa-*` tenants.
 *
 * WRITTEN, NOT RUN by the builder: the Mac mini runs it (`npm run local:test:db`). Collected only by
 * `jest.db.config.js` (`.db.spec.ts$`). `requireLocalDatabaseUrl()` refuses any non-local host; every
 * tenant is a throwaway `qa-s4-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes
 * exactly the tenants this run created.
 *
 * Flag ON  -> no SKU invented, an unpriced tier stores 0 (create, importFromZoho, createFamily).
 * Flag OFF -> master's behaviour: SKU invented, tiers copy the Retail price.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { ProductFamiliesService } from "./product-families.service";
import { UNITS_PRICES_V2_FLAG } from "./new-product-tiers";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { AuditService } from "../audit/audit.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-s4-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "products.create-defaults.db.spec.ts",
  );
};

const TIERS = ["priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

describeDb("S4 new-product data rules under flag.units_prices_v2 — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let products: ProductsService;
  let families: ProductFamiliesService;
  // Tenants whose flag is ON; the entitlement stub answers per tenant so one module serves both modes.
  const flaggedTenants = new Set<string>();
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const hasFlag = jest.fn(
      async (tenantId: string, key: string) =>
        key === UNITS_PRICES_V2_FLAG && flaggedTenants.has(tenantId),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        ProductFamiliesService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
            upload: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag } },
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
    families = module.get(ProductFamiliesService);
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
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    // ProductBarcode cascades on Product delete; variants reference the family, so children first.
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string, flagged: boolean): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `S4 ${slug}` } });
    createdTenantIds.push(tenant.id);
    if (flagged) flaggedTenants.add(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const fresh = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });

  it("flag ON: create with no tiers and no parent stores 0 tiers and a NULL sku", async () => {
    const tenantId = await seedTenant("create-on", true);
    const created = await inTenant(tenantId, () =>
      products.create({ name: "Plain Widget", unit: "each", pricePerUnit: "12.50" } as any),
    );
    const row = await fresh(created.id);
    expect(row.pricePerUnit.toString()).toBe("12.5");
    for (const c of TIERS) expect(row[c].toString()).toBe("0");
    expect(row.sku).toBeNull();
  });

  it("flag ON: two SKU-less creates both succeed (NULL never collides on the unique index)", async () => {
    const tenantId = await seedTenant("create-on-two", true);
    await inTenant(tenantId, () =>
      products.create({ name: "Blank A", unit: "each", pricePerUnit: "1", sku: "" } as any),
    );
    await expect(
      inTenant(tenantId, () =>
        products.create({ name: "Blank B", unit: "each", pricePerUnit: "1", sku: "" } as any),
      ),
    ).resolves.toBeDefined();
  });

  it("flag OFF: master copies Retail into every tier and invents a SKU", async () => {
    const tenantId = await seedTenant("create-off", false);
    const created = await inTenant(tenantId, () =>
      products.create({ name: "Plain Widget", unit: "each", pricePerUnit: "12.50" } as any),
    );
    const row = await fresh(created.id);
    for (const c of TIERS) expect(row[c].toString()).toBe("12.5");
    expect(row.sku).toMatch(/^PLA-[0-9A-F]{4}$/);
  });

  it("flag ON: importFromZoho stores 0 tiers; flag OFF copies Retail", async () => {
    for (const [flagged, expected] of [
      [true, "0"],
      [false, "3"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const tenantId = await seedTenant(`zoho-${flagged ? "on" : "off"}`, flagged);
      // eslint-disable-next-line no-await-in-loop
      const out = await inTenant(tenantId, () =>
        products.importFromZoho({
          items: [{ name: "Zoho Item", unit: "each", pricePerUnit: "3.00" }],
        } as any),
      );
      expect(out.created).toBe(1);
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.product.findFirstOrThrow({ where: { tenantId, name: "Zoho Item" } });
      for (const c of TIERS) expect(row[c].toString()).toBe(expected);
    }
  });

  it("flag ON: createFamily with a plain variant price stores 0 tiers; flag OFF copies it", async () => {
    for (const [flagged, expected] of [
      [true, "0"],
      [false, "2.5"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const tenantId = await seedTenant(`family-${flagged ? "on" : "off"}`, flagged);
      // eslint-disable-next-line no-await-in-loop
      const out = await inTenant(tenantId, () =>
        families.createFamily(
          {
            family: { name: "Soda", pricePerUnit: "1.00" },
            variants: [{ name: "Cola", pricePerUnit: "2.50" }],
          } as any,
          null,
        ),
      );
      // eslint-disable-next-line no-await-in-loop
      const kid = await prisma.product.findFirstOrThrow({
        where: { tenantId, parentProductId: out.family.id },
      });
      expect(kid.pricePerUnit.toString()).toBe("2.5");
      for (const c of TIERS) expect(kid[c].toString()).toBe(expected);
    }
  });

  it("a variant of a parent with 0 tiers inherits 0 in both modes", async () => {
    for (const flagged of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      const tenantId = await seedTenant(`inherit-${flagged ? "on" : "off"}`, flagged);
      // eslint-disable-next-line no-await-in-loop
      const parent = await prisma.product.create({
        data: {
          tenantId,
          name: "Zero Parent",
          unit: "each",
          pricePerUnit: "5",
          priceTier2: "0",
          priceTier3: "0",
          priceTier4: "0",
          priceTier5: "0",
        },
      });
      // eslint-disable-next-line no-await-in-loop
      const kid = await inTenant(tenantId, () =>
        products.create({
          name: "Zero Kid",
          unit: "each",
          pricePerUnit: "7",
          parentProductId: parent.id,
        } as any),
      );
      // eslint-disable-next-line no-await-in-loop
      const row = await fresh(kid.id);
      for (const c of TIERS) expect(row[c].toString()).toBe("0");
    }
  });
});
