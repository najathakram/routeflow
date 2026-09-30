/**
 * #2717 M2 tests 9-14 (SA-574) — DB-lane proof for recipes. Real Postgres, throwaway `qa-*` tenants.
 *
 * WRITTEN, NOT RUN by the M2 builder: the DB lane is F2's and CI's (`npm run local:test:db`); this
 * worktree makes no DB connection. Collected only by `jest.db.config.js` (`.db.spec.ts$`).
 * `requireLocalDatabaseUrl()` refuses any non-local host; every tenant is a throwaway
 * `qa-2717-rec-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
 * tenants this run created (components cascade with their recipe; recipes are deleted before
 * products because the product links are RESTRICT).
 *
 * REVERT-RED (test 9): remove `lockProductRow` and the P2002 mapper from `RecipesService.activate`
 * and both activations read the same prior ACTIVE, both retire it, and the second activate of
 * `activeFor` surfaces a raw P2002 — the per-round assertions on the 409 body and on the lock spy
 * count fail. The barrier below forces both callers past their pre-read before either takes the
 * lock, so the loser deterministically sees a changed ACTIVE row under the lock.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { RecipesService } from "./recipes.service";
import { ProductsService } from "./products.service";
import * as catalogSync from "./product-catalog-sync";
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
  return assertTestTenant(`qa-2717-rec-${RUN_SUFFIX}-${tenantSeq}-${label}`, "recipes.db.spec.ts");
};

/** Both callers must finish their pre-read before either proceeds. */
function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
  };
}

describeDb("#2717 M2 recipes — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let recipes: RecipesService;
  let products: ProductsService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecipesService,
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
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
    recipes = module.get(RecipesService);
    products = module.get(ProductsService);
  });

  afterEach(() => jest.restoreAllMocks());

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
    await prisma.recipeComponent.deleteMany({ where: { tenantId } });
    await prisma.recipe.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
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

  const product = (tenantId: string, name: string, extra: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        tenantId,
        name: `${name} ${randomUUID().slice(0, 6)}`,
        sku: `S-${randomUUID().slice(0, 8)}`,
        unit: "case",
        unitsPerBox: 12,
        pricePerUnit: "10.00",
        ...extra,
      },
    });

  /** A family with three variants and a recipe product, plus the ids to build recipes from. */
  async function seedCatalog(tenantId: string) {
    const family = await product(tenantId, "Family");
    const variants = [] as Awaited<ReturnType<typeof product>>[];
    for (const n of ["A", "B", "C"]) {
      // eslint-disable-next-line no-await-in-loop
      variants.push(await product(tenantId, `Flavor ${n}`, { parentProductId: family.id }));
    }
    const recipeProduct = await product(tenantId, "Mix");
    return { family, variants, recipeProduct };
  }

  const draftDto = (
    c: Awaited<ReturnType<typeof seedCatalog>>,
    split: [number, number] = [8, 4],
  ) => ({
    recipeProductId: c.recipeProduct.id,
    familyProductId: c.family.id,
    unitsPerPack: 12,
    components: [
      { componentProductId: c.variants[0].id, qty: split[0] },
      { componentProductId: c.variants[1].id, qty: split[1] },
    ],
  });

  /** v1 ACTIVE plus DRAFT v2 and v3, all cloned from v1. */
  async function seedVersions(tenantId: string, c: Awaited<ReturnType<typeof seedCatalog>>) {
    const v1 = await inTenant(tenantId, () => recipes.create(draftDto(c) as any));
    await inTenant(tenantId, () => recipes.activate(v1.id));
    const v2 = await inTenant(tenantId, () => recipes.createVersion(v1.id));
    const v3 = await inTenant(tenantId, () => recipes.createVersion(v1.id));
    return { v1, v2, v3 };
  }

  it("9 RACE (4 rounds): concurrent activate(v2) and activate(v3) -> exactly one ACTIVE, the loser is a 409 RECIPE_ACTIVE_CONFLICT, the lock is taken twice", async () => {
    const tenantId = await seedTenant("race-activate");
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const c = await seedCatalog(tenantId);
      // eslint-disable-next-line no-await-in-loop
      const { v2, v3 } = await seedVersions(tenantId, c);
      const wait = barrier(2);
      const original = (RecipesService.prototype as any).loadActivationPlan;
      const planSpy = jest
        .spyOn(RecipesService.prototype as any, "loadActivationPlan")
        .mockImplementation(async function (this: unknown, ...args: unknown[]) {
          const plan = await original.apply(this, args);
          await wait();
          return plan;
        });
      const lockSpy = jest.spyOn(catalogSync, "lockProductRow");
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled([
        inTenant(tenantId, () => recipes.activate(v2.id)),
        inTenant(tenantId, () => recipes.activate(v3.id)),
      ]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(rejected[0].reason.getResponse()).toMatchObject({ code: "RECIPE_ACTIVE_CONFLICT" });
      expect(lockSpy.mock.calls.filter((call) => call[2] === c.recipeProduct.id)).toHaveLength(2);
      // eslint-disable-next-line no-await-in-loop
      const active = await prisma.recipe.findMany({
        where: { tenantId, productId: c.recipeProduct.id, status: "ACTIVE" },
      });
      expect(active).toHaveLength(1);
      expect(active[0].activeFor).toBe(c.recipeProduct.id);
      planSpy.mockRestore();
      lockSpy.mockRestore();
    }
  });

  it("10 belt: a raw update giving a second recipe of one product the same activeFor -> P2002 (the index is in the migration)", async () => {
    const tenantId = await seedTenant("belt");
    const c = await seedCatalog(tenantId);
    const { v1, v2 } = await seedVersions(tenantId, c);
    // `v1` is what create() returned BEFORE activate(): its status is stale (DRAFT). v2/v3 are DRAFT clones
    // that are never activated here, so the DB row of v1 is the ACTIVE one: re-read it.
    const v1Row = await prisma.recipe.findUniqueOrThrow({ where: { id: v1.id } });
    expect(v1Row.status).toBe("ACTIVE");
    await expect(
      prisma.recipe.update({ where: { id: v2.id }, data: { activeFor: c.recipeProduct.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("11 RACE: concurrent new versions of one recipe -> one row per (productId, version), the loser is a 409 RECIPE_VERSION_CONFLICT", async () => {
    const tenantId = await seedTenant("race-version");
    const c = await seedCatalog(tenantId);
    const v1 = await inTenant(tenantId, () => recipes.create(draftDto(c) as any));
    await inTenant(tenantId, () => recipes.activate(v1.id));
    const wait = barrier(2);
    const original = (RecipesService.prototype as any).loadVersionPlan;
    jest
      .spyOn(RecipesService.prototype as any, "loadVersionPlan")
      .mockImplementation(async function (this: unknown, ...args: unknown[]) {
        const plan = await original.apply(this, args);
        await wait();
        return plan;
      });
    const results = await Promise.allSettled([
      inTenant(tenantId, () => recipes.createVersion(v1.id)),
      inTenant(tenantId, () => recipes.createVersion(v1.id)),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected[0].reason.getResponse()).toMatchObject({ code: "RECIPE_VERSION_CONFLICT" });
    const rows = await prisma.recipe.findMany({
      where: { tenantId, productId: c.recipeProduct.id, version: 2 },
    });
    expect(rows).toHaveLength(1);
  });

  it("12: a raw duplicate (recipeId, componentProductId) -> P2002; deleting a DRAFT recipe cascades its components", async () => {
    const tenantId = await seedTenant("components");
    const c = await seedCatalog(tenantId);
    const draft = await inTenant(tenantId, () => recipes.create(draftDto(c) as any));
    await expect(
      prisma.recipeComponent.create({
        data: {
          tenantId,
          recipeId: draft.id,
          componentProductId: c.variants[0].id,
          qty: 1,
          position: 9,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.recipeComponent.count({ where: { recipeId: draft.id } })).toBe(2);
    await prisma.recipe.delete({ where: { id: draft.id } });
    expect(await prisma.recipeComponent.count({ where: { recipeId: draft.id } })).toBe(0);
  });

  it("13: clearAll soft-deletes a variant and a recipe product that a recipe references, with no P2003", async () => {
    const tenantId = await seedTenant("clearall");
    const c = await seedCatalog(tenantId);
    await inTenant(tenantId, () => recipes.create(draftDto(c) as any));
    const result = await inTenant(tenantId, () => products.clearAll());
    expect(result.skipped).toEqual([]);
    const referencedIds = [c.family.id, c.variants[0].id, c.variants[1].id, c.recipeProduct.id];
    const rows = await prisma.product.findMany({ where: { id: { in: referencedIds } } });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.isActive === false)).toBe(true);
    // the unreferenced third flavor had no history, so it is hard-deleted
    expect(await prisma.product.count({ where: { id: c.variants[2].id } })).toBe(0);
  });

  it("14 tenant isolation: B sees none of A's recipes, cannot activate A's id (404), and cannot use B's product as a component in A's recipe (400)", async () => {
    const tenantA = await seedTenant("iso-a");
    const tenantB = await seedTenant("iso-b");
    const catalogA = await seedCatalog(tenantA);
    const draft = await inTenant(tenantA, () => recipes.create(draftDto(catalogA) as any));
    const seenByB = await inTenant(tenantB, () => prisma.forTenant().recipe.findMany({}));
    expect(seenByB).toHaveLength(0);
    await expect(inTenant(tenantB, () => recipes.activate(draft.id))).rejects.toMatchObject({
      status: 404,
    });
    const foreign = await product(tenantB, "B flavor", { parentProductId: catalogA.family.id });
    const bad = {
      ...draftDto(await seedCatalog(tenantA)),
      components: [
        { componentProductId: foreign.id, qty: 8 },
        { componentProductId: catalogA.variants[1].id, qty: 4 },
      ],
    };
    await expect(inTenant(tenantA, () => recipes.create(bad as any))).rejects.toMatchObject({
      status: 400,
    });
  });
});
