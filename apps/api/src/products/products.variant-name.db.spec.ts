/**
 * B1 DB-lane proof: a variant stores its BARE name; an edit never re-prefixes it (real Postgres, throwaway `qa-*`
 * tenants).
 *
 * Run by the DB lane (`npm run local:test:db`); collected only by `jest.db.config.js`. `requireLocalDatabaseUrl()`
 * refuses any non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
 *
 * The web product page used to send `name = "<parent> - <variantName>"` on every save while the server copies the
 * incoming name into `variantName`, so each edit re-prefixed ("Acme - Acme - Classic"). Proved here through the real
 * `ProductsService.update` path: edit twice -> stable; a composed incoming value (web's old payload, or an API-direct
 * caller) is stripped to the bare name; make-variant / link-existing payloads store the bare name too.
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
    `qa-b1vn-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "products.variant-name.db.spec.ts",
  );
};

describeDb("B1 variant name is stored bare: real Postgres", () => {
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
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `b1 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const mk = (tenantId: string, name: string, extra: Record<string, unknown> = {}) =>
    inTenant(tenantId, () =>
      service.create({ name, unit: "each", pricePerUnit: "1.00", ...extra } as never, {
        actorId: null,
        reparentVia: "editor",
      }),
    );
  const patch = (tenantId: string, id: string, dto: Record<string, unknown>) =>
    inTenant(tenantId, () =>
      service.update(id, dto as never, { packPrecondition: "internal", actorId: null }),
    );
  const fresh = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });

  /** The web product page's old save payload: the draft's variantName composed under the parent's name. */
  const webSave = async (tenantId: string, parentName: string, variantId: string) => {
    const row = await fresh(variantId);
    return patch(tenantId, variantId, {
      name: `${parentName} - ${(row.variantName ?? "").trim()}`,
      unit: "each",
    });
  };

  it("editing a variant twice through the web save payload keeps the bare name", async () => {
    const t = await seedTenant("edit-twice");
    const parent = await mk(t, "Acme");
    const variant = await mk(t, "Classic", { parentProductId: parent.id, variantName: "Classic" });
    expect((await fresh(variant.id)).variantName).toBe("Classic");

    const stored: Array<string | null> = [];
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await webSave(t, "Acme", variant.id);
      // eslint-disable-next-line no-await-in-loop
      stored.push((await fresh(variant.id)).variantName);
    }
    expect(stored).toEqual(["Classic", "Classic"]);
    const row = await fresh(variant.id);
    expect(row.name).toBe("Classic");
  });

  it("a composed incoming name (one or many prefixes) is stripped to the bare name", async () => {
    const t = await seedTenant("strip");
    const parent = await mk(t, "Acme");
    const variant = await mk(t, "Classic", { parentProductId: parent.id, variantName: "Classic" });

    await patch(t, variant.id, { name: "Acme - Classic" });
    expect((await fresh(variant.id)).variantName).toBe("Classic");

    await patch(t, variant.id, { name: "Acme - Acme - Spicy" });
    const row = await fresh(variant.id);
    expect(row.variantName).toBe("Spicy");
    expect(row.name).toBe("Spicy");
  });

  it("an explicit composed variantName is stripped too; a bare name containing a dash is kept", async () => {
    const t = await seedTenant("variantname");
    const parent = await mk(t, "Acme");
    const variant = await mk(t, "Classic", { parentProductId: parent.id, variantName: "Classic" });

    await patch(t, variant.id, { name: "Acme - Mint", variantName: "Acme - Mint" });
    expect((await fresh(variant.id)).variantName).toBe("Mint");

    await patch(t, variant.id, { name: "Cool - Mint" });
    expect((await fresh(variant.id)).variantName).toBe("Cool - Mint");
  });

  it("make-variant / link-existing payloads (parent + composed name) store the bare name", async () => {
    const t = await seedTenant("link");
    const parent = await mk(t, "Acme");
    const alone = await mk(t, "Old Standalone");

    await patch(t, alone.id, {
      parentProductId: parent.id,
      variantName: "Berry",
      name: "Acme - Berry",
    });
    const row = await fresh(alone.id);
    expect(row.parentProductId).toBe(parent.id);
    expect(row.variantName).toBe("Berry");
    expect(row.name).toBe("Berry");
  });

  it("a standalone product whose name merely starts like a prefix is untouched", async () => {
    const t = await seedTenant("standalone");
    const other = await mk(t, "Acme");
    const solo = await mk(t, "Solo");
    await patch(t, solo.id, { name: "Acme - Special Edition" });
    const row = await fresh(solo.id);
    expect(row.name).toBe("Acme - Special Edition");
    expect(row.variantName).toBeNull();
    expect(other.id).not.toBe(solo.id);
  });
});
