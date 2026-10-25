/**
 * Row 430 (SA-958 §3.2) — the first-tobacco auto-seed on real Postgres. Flagging a first product as tobacco creates the
 * tenant's "Tobacco" tracked category; that write is audited IN ITS OWN TRANSACTION (the seed lost its `select: { id: true }`
 * so the audit row can carry the whole row, and the resolver still hands back just `{ id }`).
 *
 * WRITTEN, NOT RUN by the builder: win-test runs it (`npm run local:test:db`). Collected only by `jest.db.config.js`.
 * Throwaway `qa-trk430-<run>-<n>` tenants (assertTestTenant); `afterAll` deletes exactly the tenants this run created.
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { AuditService } from "../audit/audit.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-trk430-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "products.tobacco-autoseed.db.spec.ts",
  );
};

describeDb("row 430: the first-tobacco auto-seed is audited — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let products: ProductsService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
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
        // Tobacco is a gated add-on: this tenant holds it.
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
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
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.trackedCategory.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenantWithProduct(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `T430 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const created = await tenantCtx.run(tenant.id, () =>
      products.create({ name: "Cigars", unit: "each", pricePerUnit: "5.00" } as any),
    );
    return { tenantId: tenant.id, productId: created.id };
  }

  const tobaccoAudits = (tenantId: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, entityType: "TrackedCategory", action: "tracked-category.created" },
    });

  it("flagging the first tobacco product seeds the type AND leaves one audit row naming the actor and the support session", async () => {
    const { tenantId, productId } = await seedTenantWithProduct("seed");
    await tenantCtx.run(tenantId, () =>
      products.update(productId, { isTobacco: true } as any, {
        packPrecondition: "internal",
        actorId: "user-op-1",
        impersonatedBy: "sa-1",
      }),
    );
    const cat = await prisma.trackedCategory.findFirstOrThrow({
      where: { tenantId, name: "Tobacco" },
    });
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).trackedCategoryId,
    ).toBe(cat.id);
    const audits = await tobaccoAudits(tenantId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityId: cat.id,
      userId: "user-op-1",
      impersonatedBy: "sa-1",
    });
    expect(audits[0].meta).toMatchObject({
      before: null,
      via: "tobacco-autoseed",
      after: expect.objectContaining({ name: "Tobacco", taxType: "NONE", active: true }),
    });
  });

  it("flagging a second product reuses the type: no second seed, no second audit row", async () => {
    const { tenantId, productId } = await seedTenantWithProduct("reuse");
    const second = await tenantCtx.run(tenantId, () =>
      products.create({ name: "Cigarillos", unit: "each", pricePerUnit: "3.00" } as any),
    );
    for (const id of [productId, second.id]) {
      // eslint-disable-next-line no-await-in-loop
      await tenantCtx.run(tenantId, () =>
        products.update(id, { isTobacco: true } as any, {
          packPrecondition: "internal",
          actorId: "user-op-1",
        }),
      );
    }
    expect(await prisma.trackedCategory.count({ where: { tenantId, name: "Tobacco" } })).toBe(1);
    expect(await tobaccoAudits(tenantId)).toHaveLength(1);
  });

  it("a system caller (no actor) still leaves the row, with no user and the auto-seed marker", async () => {
    const { tenantId, productId } = await seedTenantWithProduct("system");
    await tenantCtx.run(tenantId, () =>
      products.update(productId, { isTobacco: true } as any, { packPrecondition: "internal" }),
    );
    const [audit] = await tobaccoAudits(tenantId);
    expect(audit.userId).toBeNull();
    expect(audit.meta).toMatchObject({ via: "tobacco-autoseed" });
  });
});
