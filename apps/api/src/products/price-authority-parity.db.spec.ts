/**
 * SA-1041 DB-lane proof (real Postgres, throwaway `qa-*` tenants). Collected only by `jest.db.config.js`
 * (`npm run local:test:db`); `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * Every price writer asks `priceAuthority` (packages/pricing). This proves the three writers that touch a product's
 * base price (the grid save, the unit writer and the product editor) agree with it, in both family-price modes, and
 * that a tenant's own unit levels (Case, pallet, anything) are never blocked.
 */
import { ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { priceAuthority, type PriceAuthorityMode } from "@routeflow/pricing";
import { randomUUID } from "crypto";
import { EntitlementsService } from "../billing/entitlements.service";
import { AddonService } from "../billing/addon.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { ProductPriceGridService } from "./product-price-grid.service";
import { ProductPriceWriteService } from "./product-price-write.service";
import { ProductUnitsService } from "./product-units.service";
import { ProductsService } from "./products.service";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "price-authority-parity.db.spec.ts";
const run = randomUUID().slice(0, 8);
let seq = 0;

type Shape = "standard" | "family" | "variant" | "recipe-override" | "recipe-linked";
type Seed = { tenantId: string; productId: string; familyId: string | null };

describeDb("SA-1041 price authority parity - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let grid: ProductPriceGridService;
  let writes: ProductPriceWriteService;
  let units: ProductUnitsService;
  let products: ProductsService;
  let mode: PriceAuthorityMode = "off";
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductPriceGridService,
        ProductPriceWriteService,
        ProductUnitsService,
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn(async () => mode) },
        },
      ],
    }).compile();
    grid = module.get(ProductPriceGridService);
    writes = module.get(ProductPriceWriteService);
    units = module.get(ProductUnitsService);
    products = module.get(ProductsService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.recipe.deleteMany({ where: { tenantId } });
        await prisma.productUnit.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch(() => {});
    }
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    mode = "off";
  });

  const inTenant = <T>(id: string, fn: () => Promise<T>) => tenantCtx.run(id, fn);

  async function seed(label: string, shape: Shape): Promise<Seed> {
    seq += 1;
    const slug = assertTestTenant(`qa-sa1041-${run}-${seq}-${label}`, FILE);
    const tenant = await prisma.tenant.create({ data: { slug, name: slug } });
    tenantIds.push(tenant.id);
    const base = {
      tenantId: tenant.id,
      unit: "Box",
      unitsPerBox: 12,
      pricePerUnit: "12.00",
      priceTier2: "11.00",
    };
    const mk = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.product.create({
        data: { ...base, name, sku: `PA-${randomUUID().slice(0, 6)}`, ...extra } as any,
      });
    let familyId: string | null = null;
    let product;
    if (shape === "standard") product = await mk("Standalone");
    else if (shape === "family") product = await mk("Family", { kind: "FAMILY" });
    else if (shape === "variant") {
      const fam = await mk("Family", { kind: "FAMILY" });
      familyId = fam.id;
      product = await mk("Variant", { kind: "VARIANT", parentProductId: fam.id });
    } else {
      const fam = await mk("Family", { kind: "FAMILY" });
      familyId = fam.id;
      product = await mk("Recipe", {
        kind: "RECIPE",
        familyPriceOverride: shape === "recipe-override",
      });
      await prisma.recipe.create({
        data: {
          tenantId: tenant.id,
          productId: product.id,
          familyProductId: fam.id,
          version: 1,
          unitsPerPack: 2,
          status: "ACTIVE",
        },
      });
    }
    await prisma.productUnit.create({
      data: { tenantId: tenant.id, productId: product.id, label: "Piece", factorToBase: 1 },
    });
    await prisma.productUnit.create({
      data: { tenantId: tenant.id, productId: product.id, label: "Case", factorToBase: 72 },
    });
    return { tenantId: tenant.id, productId: product.id, familyId };
  }

  const readGrid = (s: Seed) => inTenant(s.tenantId, () => grid.get(s.productId));
  const unitRowOf = (g: any) => g.rows.find((r: any) => r.label === "Case");

  async function saveGrid(s: Seed, ref: string, to: number) {
    const g = await readGrid(s);
    return inTenant(s.tenantId, () =>
      writes.save(
        s.productId,
        {
          expectedRevision: g.revision,
          expectedPriceState: g.priceState,
          patches: [{ ref, tier: ref === "base" ? 2 : 1, to }],
        },
        null,
      ),
    );
  }

  it("R-a1: mode off, a variant's Case price is written through the grid", async () => {
    const s = await seed("a1", "variant");
    const g = await readGrid(s);
    await expect(saveGrid(s, unitRowOf(g).ref, 66)).resolves.toBeDefined();
    const row = await prisma.productUnit.findFirst({
      where: { productId: s.productId, label: "Case" },
    });
    expect(Number(row?.price)).toBe(66);
  });

  it("R-a2: mode off, the unit writer accepts a price on a variant's level", async () => {
    const s = await seed("a2", "variant");
    const created = await inTenant(s.tenantId, () =>
      units.create(s.productId, { label: "Tray", factorToBase: 6, price: 7 } as any, null),
    );
    expect(Number((created as any).price)).toBe(7);
  });

  it("R-a3: mode off, every grid row of a variant is editable except the implicit base row", async () => {
    const s = await seed("a3", "variant");
    const g = await readGrid(s);
    const locked = g.rows.filter((r: any) => !r.editable);
    expect(locked.every((r: any) => r.ref === "base")).toBe(true);
    expect(unitRowOf(g).editable).toBe(true);
  });

  it("R-a4: mode on, a variant's Case price (other level) is still written", async () => {
    const s = await seed("a4", "variant");
    mode = "on";
    const g = await readGrid(s);
    expect(unitRowOf(g).editable).toBe(true);
    await expect(saveGrid(s, unitRowOf(g).ref, 66)).resolves.toBeDefined();
  });

  it("R-a5: mode off, a recipe's base price is written through the grid", async () => {
    const s = await seed("a5", "recipe-linked");
    await expect(saveGrid(s, "base", 13)).resolves.toBeDefined();
  });

  it("G-a1: mode on, a variant's base price is refused", async () => {
    const s = await seed("g1", "variant");
    mode = "on";
    await expect(saveGrid(s, "base", 13)).rejects.toBeInstanceOf(ConflictException);
  });

  it("G-a2: a FAMILY on the grid keeps the family-page text in both modes", async () => {
    for (const m of ["off", "on"] as const) {
      mode = m;
      // eslint-disable-next-line no-await-in-loop
      const s = await seed(`g2${m}`, "family");
      // eslint-disable-next-line no-await-in-loop
      const g = await readGrid(s);
      const base = g.rows.find((r: any) => r.ref === "base");
      expect(base!.editable).toBe(false);
      expect(base!.notEditableReason).toBe("Family prices are edited on the family page.");
    }
  });

  it("G-a3: mode on, a family-linked recipe's base price is refused", async () => {
    const s = await seed("g3", "recipe-linked");
    mode = "on";
    await expect(saveGrid(s, "base", 13)).rejects.toBeInstanceOf(ConflictException);
  });

  it("G-a4: a structure-only unit create on a variant succeeds in mode on", async () => {
    const s = await seed("g4", "variant");
    mode = "on";
    await expect(
      inTenant(s.tenantId, () =>
        units.create(s.productId, { label: "Tray", factorToBase: 6 }, null),
      ),
    ).resolves.toBeDefined();
  });

  it("G-a5: the implicit base row is never editable", async () => {
    const s = await seed("g5", "standard");
    await prisma.productUnit.deleteMany({ where: { productId: s.productId } });
    const g = await readGrid(s);
    const base = g.rows.find((r: any) => r.ref === "base");
    expect(base!.editable).toBe(false);
  });

  const SHAPES: Shape[] = ["standard", "family", "variant", "recipe-override", "recipe-linked"];
  for (const shape of SHAPES) {
    for (const m of ["off", "on"] as const) {
      it(`P-a1: ${shape} / mode ${m} - grid and product editor agree with priceAuthority`, async () => {
        const s = await seed(`p1${shape}${m}`, shape);
        mode = m;
        const pr = await inTenant(s.tenantId, () =>
          prisma.product.findFirstOrThrow({ where: { id: s.productId } }),
        );
        const recipeFamilyId = shape === "recipe-linked" ? s.familyId : null;
        const verdict = priceAuthority({ ...pr, recipeFamilyId } as any, m, "base");

        // SA-1041 A-1: the pack row is base, so the grid write targets "pack"; a "base"-ref
        // write is the second assertion and must agree.
        const outcome = (ref: string, to: number) =>
          saveGrid(s, ref, to).then(
            () => "accepted",
            (e) => (e instanceof ConflictException ? "refused" : `error:${e?.message}`),
          );
        const viaGrid = await outcome("pack", 13);
        const viaGridBaseRef = await outcome("base", 13);
        const viaEditor = await inTenant(s.tenantId, () =>
          products.update(
            s.productId,
            { pricePerUnit: "14.00" } as any,
            {
              packPrecondition: "internal",
            } as any,
          ),
        ).then(
          () => "accepted",
          (e) => (e instanceof ConflictException ? "refused" : `error:${e?.message}`),
        );

        if (verdict === "own") {
          expect(viaGrid).toBe("accepted");
          expect(viaGridBaseRef).toBe("accepted");
          expect(viaEditor).toBe("accepted");
        } else if (verdict === "family") {
          expect(viaGrid).toBe("refused");
          expect(viaGridBaseRef).toBe("refused");
          expect(viaEditor).toBe("refused");
        } else {
          // family-page: only the grid refuses; the product editor is where a family is priced
          expect(viaGrid).toBe("error:Family prices are edited on the family page.");
        }
      });
    }
  }
});
