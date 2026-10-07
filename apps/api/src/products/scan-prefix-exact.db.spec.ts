/**
 * B1207 — DB-lane proof that the EXACT-code rung of the scan ladder (`findByBarcode`, which the counter sale now
 * resolves through) answers the exact product for codes that share an 11-digit prefix. The counter sale used to take
 * row 0 of the fuzzy `?search=` list: every code 200000000001..009 yields the candidate "20000000000", so each scan
 * returned the alphabetically first product, and ProductBarcode rows were never queried. Real Postgres, throwaway
 * `qa-*` tenants (assertTestTenant), local DB only.
 *
 * WRITTEN, NOT RUN by the authoring lane: the DB lane is F2's (`npm run local:test:db`). Collected only by
 * `jest.db.config.js` (`.db.spec.ts$`). L-234: scoped to this file's own fixture tenants.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
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
  return assertTestTenant(
    `qa-b1207-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "scan-prefix-exact.db.spec.ts",
  );
};

describeDb("B1207 exact scan resolution across codes sharing a prefix — real Postgres", () => {
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
    const tenant = await prisma.tenant.create({ data: { slug, name: `B1207 ${slug}` } });
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

  const SHARED_PREFIX_CODES = Array.from({ length: 9 }, (_, i) => `20000000000${i + 1}`);

  it("nine skus sharing the 11-digit prefix 20000000000: each scan returns ITS OWN product (never the first by name)", async () => {
    const t = await seedTenant("prefix-sku");
    const ids = new Map<string, string>();
    // names sort in the REVERSE order of the codes, so row 0 of a name-sorted fuzzy list is always code ...009's product
    for (const [i, code] of SHARED_PREFIX_CODES.entries()) {
      // eslint-disable-next-line no-await-in-loop
      ids.set(code, await mkProduct(t, `Item ${String.fromCharCode(90 - i)}`, { sku: code }));
    }
    for (const code of SHARED_PREFIX_CODES) {
      // eslint-disable-next-line no-await-in-loop
      const r: any = await inTenant(t, () => service.findByBarcode(code));
      expect(r.id).toBe(ids.get(code));
      expect(r.scanMatch.code).toBe(code);
    }
  });

  it("a code held ONLY in the barcode table (no Product.barcode / sku / unitSku) resolves to its product, with its level", async () => {
    const t = await seedTenant("prefix-row");
    const decoy = await mkProduct(t, "Aardvark Decoy", { sku: "20000000000X" });
    const owner = await mkProduct(t, "Zulu Owner", { sku: "ZULU-1" });
    await mkRow(t, owner, "200000000007", "UNIT");
    const r: any = await inTenant(t, () => service.findByBarcode("200000000007"));
    expect(r.id).toBe(owner);
    expect(r.id).not.toBe(decoy);
    expect(r.scanMatch).toEqual({ code: "200000000007", levels: ["UNIT"] });
  });

  it("the fuzzy list still returns several products for the shared prefix (why the client must use the exact rung)", async () => {
    const t = await seedTenant("prefix-fuzzy");
    await mkProduct(t, "Alpha", { sku: "200000000001" });
    await mkProduct(t, "Zebra", { sku: "200000000002" });
    const list: any = await inTenant(t, () =>
      service.findAll({ scanCode: "200000000002", limit: 20 } as any),
    );
    expect(list.data.length).toBeGreaterThan(1);
    const exact: any = await inTenant(t, () => service.findByBarcode("200000000002"));
    expect(exact.name).toBe("Zebra");
  });
});
