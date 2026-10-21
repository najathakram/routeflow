import { plainToInstance } from "class-transformer";
import { UpdateProductDto } from "./dto/update-product.dto";
/**
 * B1212 / B1213 / B1214 DB-lane proof for product families and their variants (real Postgres, throwaway
 * `qa-*` tenants). UNRUN when it was written (no database in the authoring checkout): the first DB-lane run
 * is its first execution.
 *
 * Run by the DB lane (`npm run local:test:db`); collected only by `jest.db.config.js`. `requireLocalDatabaseUrl()`
 * refuses any non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
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
import { sellableProductWhere } from "./sellable-product-where";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b1212-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "products-catalog-variants.db.spec.ts",
  );
};

describeDb("families and variants: delete, sellability, barcodes — real Postgres", () => {
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
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    // Variants reference the family, so children first (ProductBarcode cascades on Product delete).
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `b1212 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const row = (
    tenantId: string,
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string }> =>
    prisma.product.create({
      data: { tenantId, name, unit: "each", pricePerUnit: "1.00", ...extra } as never,
      select: { id: true },
    });

  describe("audit 2026-10-14: the Unlink button's PATCH really unlinks (it returned 200 and changed nothing)", () => {
    // The body goes through the same transform the global ValidationPipe applies, so a DTO that drops `null`
    // is caught here, not only in a unit spec.
    const unlinkBody = () =>
      plainToInstance(UpdateProductDto, { parentProductId: null, variantName: null });

    it.each([
      ["a legacy variant (standalone parent)", "STANDARD", "STANDARD"],
      ["a family variant", "FAMILY", "VARIANT"],
    ])("%s becomes standalone", async (_label, parentKind, childKind) => {
      const tenantId = await seedTenant("unlink");
      const parent = await row(tenantId, "Unlink parent", { kind: parentKind });
      const child = await row(tenantId, "Unlink parent - Red", {
        kind: childKind,
        parentProductId: parent.id,
        variantName: "Red",
      });
      await inTenant(tenantId, () =>
        service.update(child.id, unlinkBody() as never, { packPrecondition: "internal" }),
      );
      const after = await prisma.product.findUnique({
        where: { id: child.id },
        select: { parentProductId: true },
      });
      expect(after?.parentProductId).toBeNull();
    });
  });

  describe("B1212: bulkDelete / clearAll never hard-delete a product that has variants", () => {
    it("a family whose variant is outside the selection is skipped; the variant stays attached", async () => {
      const tenantId = await seedTenant("del-skip");
      const fam = await row(tenantId, "Acme Soda", { kind: "FAMILY" });
      const v = await row(tenantId, "Cherry", {
        kind: "VARIANT",
        parentProductId: fam.id,
        variantName: "Cherry",
      });
      const result = await inTenant(tenantId, () => service.bulkDelete([fam.id]));
      expect(result).toMatchObject({ deleted: 0, softDeleted: 0 });
      expect(result.skipped.map((s) => s.id)).toEqual([fam.id]);
      expect(await prisma.product.count({ where: { id: fam.id } })).toBe(1);
      expect(
        await prisma.product.findUniqueOrThrow({
          where: { id: v.id },
          select: { parentProductId: true },
        }),
      ).toEqual({ parentProductId: fam.id });
    });

    it("an archived variant under the family: the family is archived, not deleted, so no name collision can occur", async () => {
      const tenantId = await seedTenant("del-soft");
      const fam = await row(tenantId, "Acme Soda", { kind: "FAMILY" });
      const v = await row(tenantId, "Cherry", {
        kind: "VARIANT",
        parentProductId: fam.id,
        isActive: false,
      });
      const result = await inTenant(tenantId, () => service.bulkDelete([fam.id]));
      expect(result).toMatchObject({ deleted: 0, softDeleted: 1, skipped: [] });
      expect(
        await prisma.product.findUniqueOrThrow({
          where: { id: v.id },
          select: { parentProductId: true },
        }),
      ).toEqual({ parentProductId: fam.id });
      expect(
        await prisma.product.findUniqueOrThrow({
          where: { id: fam.id },
          select: { isActive: true },
        }),
      ).toEqual({ isActive: false });
    });

    it("a family and all its reference-free variants selected together are deleted together", async () => {
      const tenantId = await seedTenant("del-all");
      const fam = await row(tenantId, "Acme Soda", { kind: "FAMILY" });
      const v1 = await row(tenantId, "Cherry", { kind: "VARIANT", parentProductId: fam.id });
      const v2 = await row(tenantId, "Lime", { kind: "VARIANT", parentProductId: fam.id });
      const result = await inTenant(tenantId, () => service.bulkDelete([fam.id, v1.id, v2.id]));
      expect(result).toMatchObject({ deleted: 3, softDeleted: 0, skipped: [] });
      expect(await prisma.product.count({ where: { tenantId } })).toBe(0);
    });
  });

  describe("B1213: a variant is only as live as its family", () => {
    it("sellableProductWhere hides a variant whose parent family is inactive, and shows it under an active one", async () => {
      const tenantId = await seedTenant("sellable");
      const live = await row(tenantId, "Acme Live", { kind: "FAMILY" });
      const gone = await row(tenantId, "Acme Gone", { kind: "FAMILY", isActive: false });
      const under = await row(tenantId, "Cherry", { kind: "VARIANT", parentProductId: live.id });
      const orphan = await row(tenantId, "Lime", { kind: "VARIANT", parentProductId: gone.id });
      const solo = await row(tenantId, "Solo");
      const ids = await inTenant(tenantId, () =>
        prisma.forTenant().product.findMany({
          where: sellableProductWhere(undefined, tenantId),
          select: { id: true },
        }),
      );
      const got = ids.map((r) => r.id).sort();
      expect(got).toEqual([under.id, solo.id].sort());
      expect(got).not.toContain(orphan.id);
    });

    it("deactivating a family with active variants is a 409 until confirmed; confirmed, the variants follow", async () => {
      const tenantId = await seedTenant("cascade");
      const fam = await row(tenantId, "Acme Soda", { kind: "FAMILY" });
      const v1 = await row(tenantId, "Cherry", {
        kind: "VARIANT",
        parentProductId: fam.id,
        sku: `CH-${RUN_SUFFIX}`,
      });
      const err = await inTenant(tenantId, () =>
        service.update(fam.id, { isActive: false } as never, { packPrecondition: "internal" }),
      ).catch((e: unknown) => e);
      expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: "FAMILY_HAS_ACTIVE_VARIANTS",
        variantCount: 1,
      });
      await inTenant(tenantId, () =>
        service.update(fam.id, { isActive: false, confirmCascade: true } as never, {
          packPrecondition: "internal",
        }),
      );
      const after = await prisma.product.findUniqueOrThrow({
        where: { id: v1.id },
        select: { isActive: true, sku: true, retiredSku: true },
      });
      expect(after).toEqual({ isActive: false, sku: null, retiredSku: `CH-${RUN_SUFFIX}` });
    });

    it("a variant cannot be reactivated under an inactive family", async () => {
      const tenantId = await seedTenant("react");
      const fam = await row(tenantId, "Acme Soda", { kind: "FAMILY", isActive: false });
      const v1 = await row(tenantId, "Cherry", {
        kind: "VARIANT",
        parentProductId: fam.id,
        isActive: false,
      });
      const err = await inTenant(tenantId, () =>
        service.update(v1.id, { isActive: true } as never, { packPrecondition: "internal" }),
      ).catch((e: unknown) => e);
      expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: "VARIANT_PARENT_INACTIVE",
      });
    });
  });

  describe("B1214: a UPC-A and its EAN-13 form are one barcode", () => {
    const UPC = "036000291452";
    it("the second claimant of the other spelling is a 409 BARCODE_TAKEN", async () => {
      const tenantId = await seedTenant("gtin");
      await inTenant(tenantId, () =>
        service.create(
          { name: "Acme One", unit: "each", pricePerUnit: "1.00", barcode: UPC } as never,
          {
            actorId: null,
          },
        ),
      );
      const err = await inTenant(tenantId, () =>
        service.create(
          { name: "Acme Two", unit: "each", pricePerUnit: "1.00", barcode: `0${UPC}` } as never,
          { actorId: null },
        ),
      ).catch((e: unknown) => e);
      expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: "BARCODE_TAKEN",
      });
    });

    it("two concurrent creates of the two spellings: exactly one wins", async () => {
      const tenantId = await seedTenant("gtin-race");
      const mk = (name: string, barcode: string) =>
        inTenant(tenantId, () =>
          service.create({ name, unit: "each", pricePerUnit: "1.00", barcode } as never, {
            actorId: null,
          }),
        );
      const results = await Promise.allSettled([mk("Race A", UPC), mk("Race B", `0${UPC}`)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
  });
});
