/**
 * B1211 DB-lane proof for the parent check (real Postgres, throwaway `qa-*` tenants).
 *
 * Run by the DB lane (`npm run local:test:db`, its own fresh database); collected only by `jest.db.config.js`.
 * `requireLocalDatabaseUrl()` refuses any non-local host; every tenant is a `qa-*` slug approved by
 * `assertTestTenant`.
 *
 * Proves, against real rows: another tenant's REAL product id is refused as a parent (400, nothing written) on
 * update, create and bulk group; the product itself, a variant and an inactive product are refused; a product with
 * variants of its own cannot become a variant; a FAMILY parent marks the child VARIANT; un-parenting resets it; and
 * `findOne` never returns a foreign parent, and a RAW cross-tenant link (written around the service) is never
 * followed by `findOne`, the list or the scan lookup.
 */
import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { PRODUCT_PARENT_REASONS } from "./product-parent";
import { API_ERROR_CODES } from "../common/api-error-codes";
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
    `qa-b1211-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "products.parent-validation.db.spec.ts",
  );
};

describeDb("B1211 product parent check: real Postgres", () => {
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
    // Variants reference their parent, so children first.
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `b1211 ${slug}` } });
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
  const fresh = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });
  /** A refused parent is the coded 400: PRODUCT_PARENT_INVALID plus the `reason` of the rule it failed. */
  const badRequest = async (p: Promise<unknown>) => {
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as {
      code: string;
      reason: string;
      message: string;
    };
    expect(body.code).toBe(API_ERROR_CODES.PRODUCT_PARENT_INVALID);
    return body;
  };

  it("another tenant's REAL product id is refused as a parent on update, create and bulk group; nothing is written", async () => {
    const mine = await seedTenant("mine");
    const theirs = await seedTenant("theirs");
    const foreign = await mk(theirs, "Foreign Parent");
    const product = await mk(mine, "Mine Alone");

    expect(
      await badRequest(
        inTenant(mine, () =>
          service.update(product.id, { parentProductId: foreign.id } as never, {
            packPrecondition: "internal",
            reparentVia: "editor",
          }),
        ),
      ),
    ).toMatchObject({
      reason: PRODUCT_PARENT_REASONS.NOT_FOUND,
      message: "Parent product not found",
    });
    expect((await fresh(product.id)).parentProductId).toBeNull();

    await badRequest(mk(mine, "Mine Variant", { parentProductId: foreign.id, variantName: "V" }));
    expect(await prisma.product.count({ where: { tenantId: mine, name: "Mine Variant" } })).toBe(0);

    await badRequest(
      inTenant(mine, () =>
        service.bulkAssignParent({
          parentProductId: foreign.id,
          assignments: [{ id: product.id, variantName: "V" }],
        } as never),
      ),
    );
    expect((await fresh(product.id)).parentProductId).toBeNull();

    // and the foreign product is untouched and never returned as someone's parent
    expect(await prisma.product.count({ where: { parentProductId: foreign.id } })).toBe(0);
    const reread = await inTenant(mine, () => service.findOne(product.id));
    expect(reread.parent).toBeNull();
  });

  it("itself, a variant, an inactive product as parent, and a product with variants of its own: all 400, nothing written", async () => {
    const t = await seedTenant("rules");
    const family = await mk(t, "Family");
    const variant = await mk(t, "Variant", { parentProductId: family.id, variantName: "Variant" });
    const inactive = await mk(t, "Retired");
    await inTenant(t, () =>
      service.update(inactive.id, { isActive: false } as never, {
        packPrecondition: "internal",
      }),
    );
    const loner = await mk(t, "Loner");

    const reasonOf = async (id: string, parentId: string) => {
      const body = await badRequest(
        inTenant(t, () =>
          service.update(id, { parentProductId: parentId } as never, {
            packPrecondition: "internal",
            reparentVia: "editor",
          }),
        ),
      );
      return body.reason;
    };
    expect(await reasonOf(loner.id, loner.id)).toBe(PRODUCT_PARENT_REASONS.SELF);
    expect(await reasonOf(loner.id, variant.id)).toBe(PRODUCT_PARENT_REASONS.VARIANT_PARENT);
    expect(await reasonOf(loner.id, inactive.id)).toBe(PRODUCT_PARENT_REASONS.INACTIVE);
    // `family` has a variant of its own, so it cannot itself become a variant of `loner`.
    expect(await reasonOf(family.id, loner.id)).toBe(PRODUCT_PARENT_REASONS.HAS_VARIANTS);
    expect((await fresh(loner.id)).parentProductId).toBeNull();
    expect((await fresh(family.id)).parentProductId).toBeNull();
  });

  it("a plain parent leaves the kind alone; a FAMILY parent makes the row a VARIANT; un-parenting resets it", async () => {
    const t = await seedTenant("kind");
    const parent = await mk(t, "Plain Parent");
    const child = await mk(t, "Child", { parentProductId: parent.id, variantName: "Child" });
    expect((await fresh(child.id)).kind).toBe("STANDARD");
    // a FAMILY parent (written the way the families API writes it) makes a moved row a VARIANT
    await prisma.product.update({ where: { id: parent.id }, data: { kind: "FAMILY" } });
    const other = await mk(t, "Other Loner");
    await inTenant(t, () =>
      service.update(other.id, { parentProductId: parent.id } as never, {
        packPrecondition: "internal",
        reparentVia: "editor",
      }),
    );
    expect(await fresh(other.id)).toMatchObject({ parentProductId: parent.id, kind: "VARIANT" });
    await inTenant(t, () =>
      service.update(other.id, { parentProductId: null } as never, {
        packPrecondition: "internal",
        reparentVia: "editor",
      }),
    );
    expect(await fresh(other.id)).toMatchObject({ parentProductId: null, kind: "STANDARD" });
  });

  it("a RAW cross-tenant link (written around the service) is never followed: findOne, the list and the scan lookup return nothing foreign", async () => {
    const mine = await seedTenant("rawmine");
    const theirs = await seedTenant("rawtheirs");
    const code = RUN_SUFFIX.toUpperCase();
    const theirParent = await mk(theirs, "Their Family", { sku: `RAWP${code}` });
    const myChild = await mk(mine, "My Child", { sku: `RAWC${code}` });
    const myParent = await mk(mine, "My Family", { sku: `RAWM${code}` });
    const theirStray = await mk(theirs, "Their Stray", { sku: `RAWS${code}` });
    // The links are written with the unscoped client, bypassing every service check: one product of
    // this tenant under a parent of the other, and one product of the other under a parent of this one.
    await prisma.product.update({
      where: { id: myChild.id },
      data: { parentProductId: theirParent.id },
    });
    await prisma.product.update({
      where: { id: theirStray.id },
      data: { parentProductId: myParent.id },
    });

    try {
      // findOne: no foreign parent on the child, no foreign variant on the parent
      const child = await inTenant(mine, () => service.findOne(myChild.id));
      expect(child.parent).toBeNull();
      expect(JSON.stringify(child)).not.toContain("Their Family");
      const parent = await inTenant(mine, () => service.findOne(myParent.id));
      expect(parent.variants.map((v) => v.id)).not.toContain(theirStray.id);

      // the list (with variants)
      const list = await inTenant(mine, () =>
        service.findAll({ includeVariants: true, page: 1, limit: 100 } as never),
      );
      const listedChild = list.data.find((r) => r.id === myChild.id);
      const listedParent = list.data.find((r) => r.id === myParent.id);
      expect(listedChild?.parent).toBeNull();
      const listedVariants = (listedParent as { variants?: { id: string }[] } | undefined)
        ?.variants;
      expect((listedVariants ?? []).map((v) => v.id)).not.toContain(theirStray.id);
      expect(JSON.stringify(list)).not.toContain("Their Family");
      expect(JSON.stringify(list)).not.toContain("Their Stray");

      // the scan lookup
      const scannedChild = await inTenant(mine, () => service.findByBarcode(`RAWC${code}`));
      expect(scannedChild.parent).toBeNull();
      const scannedParent = await inTenant(mine, () => service.findByBarcode(`RAWM${code}`));
      expect(scannedParent.variants.map((v) => v.id)).not.toContain(theirStray.id);
    } finally {
      // Undo the raw links so tenant cleanup does not trip over a row that points into the other tenant.
      await prisma.product.updateMany({
        where: { id: { in: [myChild.id, theirStray.id] } },
        data: { parentProductId: null },
      });
    }
  });
});
