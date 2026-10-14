/**
 * B1 (SA ruling) DB-lane proof: EVERY writer of a variant's name / variantName stores the bare label (real Postgres,
 * throwaway `qa-*` tenants). Writers: create, update (web save / make-variant / link-existing), bulk assign-parent,
 * the stock split's new variant, the import variant resolver, and the family create / add / rename paths.
 * Matching is case-insensitive and whitespace-tolerant; make-variant and link-existing leave the PARENT's name alone.
 *
 * Run by the DB lane (`npm run local:test:db`); collected only by `jest.db.config.js`. `requireLocalDatabaseUrl()`
 * refuses any non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { ProductFamiliesService } from "./product-families.service";
import { InventoryService } from "../inventory/inventory.service";
import { VariantResolutionService } from "../import/variant-resolution.service";
import { ProductAliasService } from "../import/product-alias.service";
import { AuditService } from "../audit/audit.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
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
    `qa-b1w-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "products.variant-name-writers.db.spec.ts",
  );
};

describeDb("B1 every variant-name writer stores the bare label: real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let products: ProductsService;
  let families: ProductFamiliesService;
  let inventory: InventoryService;
  let resolver: VariantResolutionService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        ProductFamiliesService,
        InventoryService,
        VariantResolutionService,
        ProductAliasService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
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
    products = module.get(ProductsService);
    families = module.get(ProductFamiliesService);
    inventory = module.get(InventoryService);
    resolver = module.get(VariantResolutionService);
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
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `b1w ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const mk = (tenantId: string, name: string, extra: Record<string, unknown> = {}) =>
    inTenant(tenantId, () =>
      products.create({ name, unit: "each", pricePerUnit: "1.00", ...extra } as never, {
        actorId: null,
      }),
    );
  const patch = (tenantId: string, id: string, dto: Record<string, unknown>) =>
    inTenant(tenantId, () => products.update(id, dto as never, { actorId: null }));
  const fresh = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });
  const labels = async (id: string) => {
    const r = await fresh(id);
    return { name: r.name, variantName: r.variantName };
  };

  it("create(): a composed name is stored bare, case- and whitespace-insensitively", async () => {
    const t = await seedTenant("create");
    const parent = await mk(t, "Acme");
    const a = await mk(t, "ACME  -  acme - Classic", { parentProductId: parent.id });
    expect(await labels(a.id)).toEqual({ name: "Classic", variantName: null });
    const b = await mk(t, "Mint", { parentProductId: parent.id, variantName: "Acme - Mint" });
    expect(await labels(b.id)).toEqual({ name: "Mint", variantName: "Mint" });
    const partial = await mk(t, "Acmeberry - X", { parentProductId: parent.id });
    expect((await fresh(partial.id)).name).toBe("Acmeberry - X");
  });

  it("update(): case/whitespace variants and repeats are stripped; a partial word is not", async () => {
    const t = await seedTenant("update");
    const parent = await mk(t, "Big Acme");
    const v = await mk(t, "Classic", { parentProductId: parent.id, variantName: "Classic" });
    await patch(t, v.id, { name: "  BIG   ACME - big acme  -  Spicy  " });
    expect(await labels(v.id)).toEqual({ name: "Spicy", variantName: "Spicy" });
    await patch(t, v.id, { name: "Big - Hot" });
    expect(await labels(v.id)).toEqual({ name: "Big - Hot", variantName: "Big - Hot" });
  });

  it("make-variant / link-existing leave the PARENT's name untouched", async () => {
    const t = await seedTenant("parent");
    const parent = await mk(t, "Acme");
    const alone = await mk(t, "Old Standalone");
    // the page's two PATCHes, in order: the parent's own variant name (no `name`), then the child link
    await patch(t, parent.id, { variantName: "Original" });
    await patch(t, alone.id, {
      parentProductId: parent.id,
      variantName: "Berry",
      name: "Berry",
    });
    expect(await labels(parent.id)).toEqual({ name: "Acme", variantName: "Original" });
    expect(await labels(alone.id)).toEqual({ name: "Berry", variantName: "Berry" });
  });

  it("bulkAssignParent: composed assignment names are stored bare", async () => {
    const t = await seedTenant("bulk");
    const parent = await mk(t, "Acme");
    const x = await mk(t, "Standalone X");
    const res = await inTenant(t, () =>
      products.bulkAssignParent({
        parentProductId: parent.id,
        assignments: [{ id: x.id, variantName: "acme - Cherry" }],
      } as never),
    );
    expect(res.succeeded).toEqual([x.id]);
    expect(await labels(x.id)).toEqual({ name: "Cherry", variantName: "Cherry" });
  });

  it("stock split: a NEW variant is stored bare (name and variantName)", async () => {
    const t = await seedTenant("split");
    const user = await prisma.user.create({
      data: { email: `${t}@example.invalid`, username: `u-${t}`, role: "OPERATOR", tenantId: t },
    });
    const parent = await prisma.product.create({
      data: {
        tenantId: t,
        name: "Acme",
        unit: "each",
        pricePerUnit: "10.00",
        priceTier2: "10.00",
        priceTier3: "10.00",
        priceTier4: "10.00",
        priceTier5: "10.00",
        currentStock: 20,
        averageCost: 4,
      },
    });
    await inTenant(t, () =>
      inventory.assignToVariants(
        {
          parentProductId: parent.id,
          assignments: [{ newVariant: { name: "ACME - Grape" }, qty: 5 }],
        } as never,
        user.id,
      ),
    );
    const grape = await prisma.product.findFirstOrThrow({
      where: { tenantId: t, parentProductId: parent.id },
    });
    expect(await labels(grape.id)).toEqual({ name: "Grape", variantName: "Grape" });
  });

  it("import resolver: a new variant is stored bare", async () => {
    const t = await seedTenant("import");
    const parent = await mk(t, "Acme");
    const created = await inTenant(t, () =>
      resolver.createVariant({ parentProductId: parent.id, variantName: "Acme - Plum" }),
    );
    expect(await labels(created.id)).toEqual({ name: "Plum", variantName: "Plum" });
  });

  it("family create: variants named under the family are stored bare", async () => {
    const t = await seedTenant("fam-create");
    const res = await inTenant(t, () =>
      families.createFamily(
        {
          family: { name: "Acme", pricePerUnit: "1.00" },
          variants: [
            { name: "ACME - Kid", pricePerUnit: "1.00" },
            { name: "Acme - acme - Teen", pricePerUnit: "1.00" },
          ],
        } as never,
        null,
      ),
    );
    const rows = await prisma.product.findMany({
      where: { tenantId: t, parentProductId: res.family.id },
      orderBy: { name: "asc" },
    });
    expect(rows.map((r) => [r.name, r.variantName])).toEqual([
      ["Kid", "Kid"],
      ["Teen", "Teen"],
    ]);
  });

  it("family grid: an added variant and a renamed variant are stored bare", async () => {
    const t = await seedTenant("fam-grid");
    const res = await inTenant(t, () =>
      families.createFamily(
        {
          family: { name: "Acme", pricePerUnit: "1.00" },
          variants: [{ name: "Kid", pricePerUnit: "1.00" }],
        } as never,
        null,
      ),
    );
    const kid = res.variants[0].id;
    const out = await inTenant(t, () =>
      families.updateVariants(
        res.family.id,
        {
          add: [{ name: "acme - Mint", pricePerUnit: "1.00" }],
          update: [{ id: kid, name: "ACME - Kiddo" }],
        } as never,
        null,
      ),
    );
    expect(await labels(kid)).toEqual({ name: "Kiddo", variantName: "Kiddo" });
    expect(await labels(out.added[0])).toEqual({ name: "Mint", variantName: "Mint" });
  });
});
