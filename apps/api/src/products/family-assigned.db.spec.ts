/**
 * SA-823 R11 (T14) DB-lane proof (real Postgres, throwaway `qa-*` tenants; `npm run local:test:db`).
 * Proves: an editor-style update() and a bulk assign each persist exactly one `product.family_assigned` row (from/to/via);
 * an unlink persists one with toParentId null; a forced rollback after the reparent persists neither the parent
 * change nor the row (they share ONE transaction).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
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
    `qa-sa823-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "family-assigned.db.spec.ts",
  );
};

describeDb("SA-823 R11 family_assigned audit row: real Postgres", () => {
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
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        entitlementAuthorityFromEntitlements,
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
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    // Variants reference their parent, so children first.
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `sa823 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const mk = (tenantId: string, name: string, extra: Record<string, unknown> = {}) =>
    inTenant(tenantId, () =>
      service.create({ name, unit: "each", pricePerUnit: "1.00", ...extra } as never, {
        actorId: null,
      }),
    );
  const fresh = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });
  const family = (tenantId: string, name: string) =>
    prisma.product.create({
      data: { tenantId, name, unit: "each", pricePerUnit: "1.00", kind: "FAMILY" },
    });
  const rowsFor = (tenantId: string, entityId: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, entityId, action: AUDIT_ACTIONS.PRODUCT_FAMILY_ASSIGNED },
    });

  it("an editor update and a bulk assign each persist one row; an unlink persists one with toParentId null", async () => {
    const t = await seedTenant("rows");
    const fam = await family(t, "Soda");
    const a = await mk(t, "Loose A");
    const b = await mk(t, "Loose B");

    await inTenant(t, () =>
      service.update(
        a.id,
        { parentProductId: fam.id, variantName: "Cola", name: "Cola" } as never,
        {
          packPrecondition: "internal",
          reparentVia: "editor",
        },
      ),
    );
    const editor = await rowsFor(t, a.id);
    expect(editor).toHaveLength(1);
    expect(editor[0].meta).toEqual({
      productId: a.id,
      fromParentId: null,
      toParentId: fam.id,
      variantName: "Cola",
      via: "editor",
    });

    const out = await inTenant(t, () =>
      service.bulkAssignParent({
        parentProductId: fam.id,
        assignments: [{ id: b.id, variantName: "Lime" }],
      } as never),
    );
    expect(out.succeeded).toEqual([b.id]);
    const bulk = await rowsFor(t, b.id);
    expect(bulk).toHaveLength(1);
    expect(bulk[0].meta).toMatchObject({ toParentId: fam.id, via: "bulk_assign" });

    await inTenant(t, () => service.unlinkFromParent(a.id, { via: "editor" }));
    const after = await rowsFor(t, a.id);
    expect(after).toHaveLength(2);
    expect(after.map((r) => (r.meta as { toParentId: string | null }).toParentId)).toContain(null);

    // an echo of the current parent writes nothing
    await inTenant(t, () =>
      service.update(b.id, { parentProductId: fam.id, description: "x" } as never, {
        packPrecondition: "internal",
      }),
    );
    expect(await rowsFor(t, b.id)).toHaveLength(1);
  });

  it("a forced failure after the reparent persists neither the parent change nor the row", async () => {
    const t = await seedTenant("rollback");
    const fam = await family(t, "Juice");
    const p = await mk(t, "Loose C");
    const real = prisma.tenantTransaction.bind(prisma);
    const spy = jest.spyOn(prisma, "tenantTransaction").mockImplementationOnce(((
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown,
    ) =>
      (real as any)(async (tx: unknown) => {
        await fn(tx);
        throw new Error("forced rollback");
      }, opts)) as never);
    await expect(
      inTenant(t, () => service.assignToParent(p.id, fam.id, "Apple", { via: "bulk_assign" })),
    ).rejects.toThrow("forced rollback");
    spy.mockRestore();
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).parentProductId,
    ).toBeNull();
    expect(await rowsFor(t, p.id)).toHaveLength(0);
  });
});
