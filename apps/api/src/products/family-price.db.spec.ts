/**
 * #2717 M2 tests 24-25 (SA-574 Q2) — DB-lane proof for the family price write-through. Real
 * Postgres, throwaway `qa-*` tenants.
 *
 * WRITTEN, NOT RUN by the M2 builder: the DB lane is F2's and CI's (`npm run local:test:db`); this
 * worktree makes no DB connection. Collected only by `jest.db.config.js` (`.db.spec.ts$`).
 * `requireLocalDatabaseUrl()` refuses any non-local host; every tenant is a throwaway
 * `qa-2717-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the tenants
 * this run created.
 *
 * REVERT-RED (test 24): remove the family row lock from `loadLockedFamilyPrices`/`lockFamilyRow`
 * and the variant create reads the family's PRE-edit tiers in its own tx while the edit's
 * propagation cannot see the uncommitted variant, so the variant ends stale in at least one of the
 * rounds. The spies prove both writers went through the family-price entry points each round.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import * as familyPrice from "./family-price";
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
import { FeatureConfigService } from "../billing/feature-config.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(`qa-2717-${RUN_SUFFIX}-${tenantSeq}-${label}`, "family-price.db.spec.ts");
};

describeDb("#2717 M2 family price write-through — real Postgres", () => {
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
          useValue: { presignedUrls: jest.fn().mockResolvedValue([]) },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        // #2185: the reorder gate's deny body reads admin overrides.
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("on") },
        },
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
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    // Variants reference their family (parentProductId): delete children first.
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `2717 M2 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function seedFamily(tenantId: string, label: string) {
    return prisma.product.create({
      data: {
        tenantId,
        name: `Family ${label}`,
        sku: `FAM-${label}-${randomUUID().slice(0, 6)}`,
        unit: "case",
        unitsPerBox: 12,
        pricePerUnit: "10.00",
        priceTier2: "9.50",
        priceTier3: "9.00",
        priceTier4: "8.50",
        priceTier5: "8.00",
      },
    });
  }

  it("RACE (6 rounds): a family price edit and a variant create in parallel -> the variant ends with the post-edit tiers", async () => {
    const tenantId = await seedTenant("race");
    const beforeSpy = jest.spyOn(familyPrice, "applyFamilyPriceBeforeUpdate");
    const createSpy = jest.spyOn(familyPrice, "familyPricesForNewVariant");
    try {
      for (let round = 0; round < 6; round += 1) {
        // eslint-disable-next-line no-await-in-loop
        const family = await seedFamily(tenantId, `r${round}`);
        const newTier3 = `${5 + round}.50`;
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.allSettled([
          inTenant(tenantId, () =>
            service.update(family.id, { priceTier3: newTier3 } as any, {
              packPrecondition: "internal",
            }),
          ),
          inTenant(tenantId, () =>
            service.create({
              name: `Flavor ${round}`,
              variantName: `Flavor ${round}`,
              parentProductId: family.id,
              unit: "case",
              pricePerUnit: "10.00",
            } as any),
          ),
        ]);
        // The create may lose to a stale-dto 409 only if the edit changed a column the dto names;
        // this edit touches tier 3 alone, so both must succeed.
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
        // eslint-disable-next-line no-await-in-loop
        const variants = await prisma.product.findMany({
          where: { tenantId, parentProductId: family.id },
        });
        expect(variants).toHaveLength(1);
        // Compare as numbers: a Decimal prints "5.5" where toFixed(2) prints "5.50".
        expect(Number(variants[0].priceTier3)).toBe(Number(newTier3));
      }
      expect(beforeSpy).toHaveBeenCalledTimes(6);
      expect(createSpy).toHaveBeenCalledTimes(6);
    } finally {
      beforeSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it("tenant scope: a corrupt tenant-B row whose parentProductId is A's family is untouched by A's propagation", async () => {
    const tenantA = await seedTenant("scope-a");
    const tenantB = await seedTenant("scope-b");
    const family = await seedFamily(tenantA, "scope");
    const ownVariant = await prisma.product.create({
      data: {
        tenantId: tenantA,
        name: "A variant",
        sku: `AV-${randomUUID().slice(0, 6)}`,
        unit: "case",
        pricePerUnit: "1.00",
        parentProductId: family.id,
      },
    });
    // The FK on parentProductId has no tenant check, so a cross-tenant pointer is representable.
    const foreign = await prisma.product.create({
      data: {
        tenantId: tenantB,
        name: "B corrupt variant",
        sku: `BV-${randomUUID().slice(0, 6)}`,
        unit: "case",
        pricePerUnit: "3.00",
        parentProductId: family.id,
      },
    });
    await inTenant(tenantA, () =>
      service.update(family.id, { priceTier3: "7.25" } as any, { packPrecondition: "internal" }),
    );
    const after = await prisma.product.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.pricePerUnit.toString()).toBe("3");
    expect(after.priceTier3.toString()).toBe("0");
    const mine = await prisma.product.findUniqueOrThrow({ where: { id: ownVariant.id } });
    expect(mine.priceTier3.toString()).toBe("7.25");
    expect(mine.pricePerUnit.toString()).toBe("10");
  });
});
