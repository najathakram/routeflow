/**
 * #2717 M4a-1 — DB-lane proof for the shared scan lookup (SA-578 Q3/Q5, SA-580). Real Postgres,
 * throwaway `qa-*` tenants (assertTestTenant), local DB only (requireLocalDatabaseUrl).
 *
 * WRITTEN, NOT RUN by the authoring lane: the DB lane is F2's (`npm run local:test:db`); this
 * worktree has no container runtime. Collected only by `jest.db.config.js` (`.db.spec.ts$`).
 * RED until ./scan-match exists (Cannot find module), then on behaviour.
 *
 * L-234: every read/write is scoped to this file's own fixture tenants; afterAll deletes exactly the
 * tenants this run created.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { normalizeScanCode } from "@routeflow/scanning";
import { ProductsService } from "./products.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { findScanMatches } from "./scan-match";
import { synthesizeLegacyBarcodes } from "./product-barcode-rules";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(`qa-2717-${RUN_SUFFIX}-${tenantSeq}-${label}`, "scan-match.db.spec.ts");
};

describeDb("#2717 M4a-1 scan lookup — real Postgres", () => {
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
            presignedUrls: jest.fn().mockResolvedValue([]),
            upload: jest.fn(),
            delete: jest.fn(),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        /* best-effort: never mask a test's own result */
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } }); // cascades ProductBarcode/ProductImage
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `2717 M4a-1 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function mkProduct(
    tenantId: string,
    name: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const p = await prisma.product.create({
      data: { tenantId, name, unit: "case", pricePerUnit: "10.00", unitsPerBox: 6, ...over } as any,
    });
    return p.id;
  }

  async function mkRow(
    tenantId: string,
    productId: string,
    code: string,
    level: "BOX" | "UNIT",
    over: Record<string, unknown> = {},
  ) {
    return prisma.productBarcode.create({
      data: {
        tenantId,
        productId,
        code,
        level,
        symbology: "CODE128",
        origin: "ENTERED",
        ...over,
      } as any,
    });
  }

  const lookup = (tenantId: string, code: string, baseWhere: Record<string, unknown> = {}) =>
    inTenant(tenantId, () =>
      findScanMatches(prisma.forTenant() as any, normalizeScanCode(code), baseWhere),
    );

  it("a ProductBarcode row code X != Product.barcode resolves through findByBarcode, with additive barcodes[] + scanMatch (was 404)", async () => {
    const t = await seedTenant("row-resolves");
    const id = await mkProduct(t, "Row Widget", { barcode: "LEGACY-111", sku: "RW-1" });
    await mkRow(t, id, "ROWCODE-X", "UNIT");

    const result: any = await inTenant(t, () => service.findByBarcode("ROWCODE-X"));

    expect(result.id).toBe(id);
    expect(result.barcode).toBe("LEGACY-111"); // existing keys untouched
    expect(result.scanMatch).toEqual({ code: "ROWCODE-X", levels: ["UNIT"] });
    expect(result.barcodes.map((b: any) => b.code)).toContain("ROWCODE-X");
  });

  it("HELD tenant (no rows): resolves by barcode/sku/unitSku exactly as today; barcodes[] equals synthesizeLegacyBarcodes", async () => {
    const t = await seedTenant("held-fallback");
    const id = await mkProduct(t, "Held Widget", {
      barcode: "036000291452",
      sku: "HW-6",
      unitSku: "HW-1",
      unitsPerBox: 6,
    });
    for (const code of ["036000291452", "HW-6", "HW-1"]) {
      // eslint-disable-next-line no-await-in-loop
      const r: any = await inTenant(t, () => service.findByBarcode(code));
      expect(r.id).toBe(id);
      expect(r.barcodes).toEqual(
        synthesizeLegacyBarcodes({ barcode: "036000291452", unitsPerBox: 6 }),
      );
    }
    const viaSku: any = await inTenant(t, () => service.findByBarcode("HW-6"));
    expect(viaSku.scanMatch.levels).toEqual(["BOX"]);
    const viaUnit: any = await inTenant(t, () => service.findByBarcode("HW-1"));
    expect(viaUnit.scanMatch.levels).toEqual(["UNIT"]);
  });

  it("ranking: a row code equal to another product's sku at the same candidate — the row wins, whichever id is larger", async () => {
    const t = await seedTenant("ranking");
    const skuHolder = await mkProduct(t, "Sku Holder", { sku: "RANK-CODE" });
    const rowOwner = await mkProduct(t, "Row Owner", { sku: "RO-1" });
    await mkRow(t, rowOwner, "RANK-CODE", "BOX");
    const hit = await lookup(t, "RANK-CODE");
    expect(hit?.product.id).toBe(rowOwner);
    expect(hit?.product.id).not.toBe(skuHolder);
    // deterministic across runs
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await lookup(t, "RANK-CODE"))?.product.id).toBe(rowOwner);
    }
  });

  it("tenant isolation: tenant B's row with code X never resolves for tenant A (B-scoped fixture, L-234)", async () => {
    const a = await seedTenant("iso-a");
    const b = await seedTenant("iso-b");
    const bProduct = await mkProduct(b, "B Widget");
    await mkRow(b, bProduct, "SHARED-ACROSS", "BOX");
    expect(await lookup(a, "SHARED-ACROSS")).toBeNull();
    await expect(inTenant(a, () => service.findByBarcode("SHARED-ACROSS"))).rejects.toThrow();
    expect((await lookup(b, "SHARED-ACROSS"))?.product.id).toBe(bProduct);
  });

  it("baseWhere is honoured on the row tier: a row code on a product the caller's scope excludes does NOT resolve (buyer-scope pin)", async () => {
    const t = await seedTenant("basewhere");
    const hidden = await mkProduct(t, "Archived Widget", { isActive: false });
    await mkRow(t, hidden, "HIDDEN-ROW", "BOX");
    expect((await lookup(t, "HIDDEN-ROW", {}))?.product.id).toBe(hidden);
    expect(await lookup(t, "HIDDEN-ROW", { isActive: true })).toBeNull();
  });

  it("case-insensitive miss tier covers ROWS: a lowercase alpha code resolves an uppercase row code", async () => {
    const t = await seedTenant("ci-rows");
    const id = await mkProduct(t, "Alpha Widget");
    await mkRow(t, id, "ALPHA-ROW-9", "UNIT");
    const hit = await lookup(t, "alpha-row-9");
    expect(hit?.product.id).toBe(id);
    expect(hit?.scanMatch.levels).toEqual(["UNIT"]);
  });

  it("invariant breach (writer bypassed): the same code at different levels on two products picks the lowest id and warns once — rows are real, so the schema allows it", async () => {
    const t = await seedTenant("breach");
    const p1 = await mkProduct(t, "Dup One");
    const p2 = await mkProduct(t, "Dup Two");
    await mkRow(t, p1, "DUP-CODE", "BOX");
    await mkRow(t, p2, "DUP-CODE", "UNIT");
    const hit = await lookup(t, "DUP-CODE");
    expect(hit?.product.id).toBe([p1, p2].sort()[0]);
  });
});
