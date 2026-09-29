/**
 * SA-584 B2 (#2717 M2 fold) — DB-lane proof that a recipe's invariants are KEPT, not only checked
 * at draft time. Real Postgres, throwaway `qa-2717-fold-<run>-<n>` tenants (assertTestTenant).
 *
 *  - SERIALIZED (4 rounds): a component re-parent (`ProductsService.update`) and `activate` started
 *    together never yield an ACTIVE recipe with a component that is not a variant of the family. The
 *    DRAFT is already open, so the re-parent is ALWAYS a 409 RECIPE_FAMILY_LOCKED whatever the
 *    interleaving (a check that the guard holds under concurrency, not a two-outcome race). Never 40P01.
 *  - RACE (6 rounds, two outcomes): a component DEACTIVATE (allowed while a recipe is open, SA-584b) and
 *    `activate` started together: either activate wins, or it refuses 400 COMPONENT_INACTIVE.
 *  - SA-587 RACE (6 rounds): `recipes.create(R)` vs `ProductsService.update(R, { parentProductId })`
 *    never leaves R with BOTH a recipe and a parent: exactly one side wins, the loser gets the 409.
 *    Revert-red: deciding RECIPE_PRODUCT_HAS_PARENT from the PRE-lock recipe read (recipe-update-guard.ts)
 *    lets both win in some round.
 *  - SA-587a: tracked-categories assign/unassign vs an open recipe is a 409 with NOTHING written.
 *  - LOCK EDGE: a raw writer holds the FAMILY row and has un-committedly re-parented a component;
 *    `activate` must BLOCK on the family lock (house order: family -> recipe product -> components)
 *    and, once the writer commits, refuse the activation. Before the fix activate never touched the
 *    family row, did not block, and activated a recipe over a re-parented component.
 *  - a family `unitsPerBox` edit (and a recipe-product one) with an open recipe is a 409.
 *
 * WRITTEN, NOT RUN by the fold implementer: F2 owns the DB lane (`npm run local:test:db`).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { RecipesService } from "./recipes.service";
import { ProductsService } from "./products.service";
import { TrackedCategoriesService } from "../tracked-categories/tracked-categories.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
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
  return assertTestTenant(
    `qa-2717-fold-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "recipes-fold.db.spec.ts",
  );
};

const stateOf = (err: any): string | undefined =>
  err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code;

describeDb("#2717 M2 fold: recipe invariants are kept — real Postgres", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let recipes: RecipesService;
  let products: ProductsService;
  let categories: TrackedCategoriesService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecipesService,
        ProductsService,
        TrackedCategoriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
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
    categories = module.get(TrackedCategoriesService);
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.recipeComponent.deleteMany({ where: { tenantId } });
    await prisma.recipe.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.trackedCategory.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `2717 fold ${slug}` } });
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

  async function seedDraft(tenantId: string, extra: Record<string, unknown> = {}) {
    const family = await product(tenantId, "Family", extra);
    const variants = [] as Awaited<ReturnType<typeof product>>[];
    for (const n of ["A", "B", "C"]) {
      // eslint-disable-next-line no-await-in-loop
      variants.push(
        await product(tenantId, `Flavor ${n}`, { parentProductId: family.id, ...extra }),
      );
    }
    const recipeProduct = await product(tenantId, "Mix", extra);
    const draft = await inTenant(tenantId, () =>
      recipes.create({
        recipeProductId: recipeProduct.id,
        familyProductId: family.id,
        unitsPerPack: 12,
        components: [
          { componentProductId: variants[0].id, qty: 8 },
          { componentProductId: variants[1].id, qty: 4 },
        ],
      } as any),
    );
    return { family, variants, recipeProduct, draft };
  }

  /** Polls until some backend is blocked by `blockerPid`; false if `done()` or the deadline comes first. */
  async function waitUntilBlockedBy(blockerPid: number, done: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !done()) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
        [blockerPid],
      );
      if (rows[0].n > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  async function activeRecipeHasNonFamilyComponent(tenantId: string): Promise<boolean> {
    const active = await prisma.recipe.findMany({
      where: { tenantId, status: "ACTIVE" },
      include: { components: true },
    });
    for (const r of active) {
      for (const c of r.components) {
        // eslint-disable-next-line no-await-in-loop
        const p = await prisma.product.findUniqueOrThrow({ where: { id: c.componentProductId } });
        if (p.parentProductId !== r.familyProductId) return true;
      }
    }
    return false;
  }

  it("SERIALIZED (4 rounds): a component re-parent started with activate is always a 409, and no ACTIVE recipe ends over a non-family component", async () => {
    const tenantId = await seedTenant("race-reparent");
    for (let round = 0; round < 4; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const c = await seedDraft(tenantId);
      // eslint-disable-next-line no-await-in-loop
      const [activated, reparented] = await Promise.allSettled([
        inTenant(tenantId, () => recipes.activate(c.draft.id)),
        inTenant(tenantId, () =>
          products.update(c.variants[0].id, { parentProductId: null } as any),
        ),
      ]);
      for (const r of [activated, reparented]) {
        if (r.status === "rejected") expect(stateOf(r.reason)).not.toBe("40P01");
      }
      // The DRAFT is open from the start, so the re-parent can never win.
      expect(reparented.status).toBe("rejected");
      expect((reparented as PromiseRejectedResult).reason.getResponse()).toMatchObject({
        code: "RECIPE_FAMILY_LOCKED",
      });
      expect(activated.status).toBe("fulfilled");
      // eslint-disable-next-line no-await-in-loop
      expect(await activeRecipeHasNonFamilyComponent(tenantId)).toBe(false);
    }
  }, 120_000);

  it("RACE (6 rounds, two outcomes): a component deactivate vs activate is either 'activate first' or 400 COMPONENT_INACTIVE, never 40P01", async () => {
    const tenantId = await seedTenant("race-deactivate");
    let activateWon = 0;
    let deactivateWon = 0;
    for (let round = 0; round < 6; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const c = await seedDraft(tenantId);
      // eslint-disable-next-line no-await-in-loop
      const [activated, deactivated] = await Promise.allSettled([
        inTenant(tenantId, () => recipes.activate(c.draft.id)),
        inTenant(tenantId, () => products.update(c.variants[1].id, { isActive: false } as any)),
      ]);
      for (const r of [activated, deactivated]) {
        if (r.status === "rejected") expect(stateOf(r.reason)).not.toBe("40P01");
      }
      expect(deactivated.status).toBe("fulfilled"); // a deactivate is never refused (SA-584b)
      if (activated.status === "fulfilled") {
        activateWon += 1;
      } else {
        deactivateWon += 1;
        expect(activated.reason.getResponse()).toMatchObject({
          code: "RECIPE_INVALID",
          reason: "COMPONENT_INACTIVE",
        });
        // eslint-disable-next-line no-await-in-loop
        const still = await prisma.recipe.findUniqueOrThrow({ where: { id: c.draft.id } });
        expect(still.status).toBe("DRAFT");
      }
    }
    expect(activateWon + deactivateWon).toBe(6);
  }, 120_000);

  it("SA-587 RACE (6 rounds): recipes.create(R) vs update(R, { parentProductId }) never leaves R with a recipe AND a parent", async () => {
    const tenantId = await seedTenant("race-adopt");
    let recipeWon = 0;
    let parentWon = 0;
    for (let round = 0; round < 6; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const family = await product(tenantId, "Family");
      // eslint-disable-next-line no-await-in-loop
      const adopter = await product(tenantId, "Adopter family");
      // eslint-disable-next-line no-await-in-loop
      const variant = await product(tenantId, "Flavor", { parentProductId: family.id });
      // eslint-disable-next-line no-await-in-loop
      const r = await product(tenantId, "Mix");
      // eslint-disable-next-line no-await-in-loop
      const [created, adopted] = await Promise.allSettled([
        inTenant(tenantId, () =>
          recipes.create({
            recipeProductId: r.id,
            familyProductId: family.id,
            unitsPerPack: 12,
            components: [{ componentProductId: variant.id, qty: 12 }],
          } as any),
        ),
        inTenant(tenantId, () => products.update(r.id, { parentProductId: adopter.id } as any)),
      ]);
      for (const x of [created, adopted]) {
        if (x.status === "rejected") expect(stateOf(x.reason)).not.toBe("40P01");
      }
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.product.findUniqueOrThrow({ where: { id: r.id } });
      // eslint-disable-next-line no-await-in-loop
      const recipeCount = await prisma.recipe.count({ where: { tenantId, productId: r.id } });
      // The invariant: never both.
      expect(recipeCount > 0 && row.parentProductId !== null).toBe(false);
      // Exactly one side won; the loser got the 409 (the adoption's 409, or create's 400/409 shape refusal).
      expect([created.status, adopted.status].sort()).toEqual(["fulfilled", "rejected"]);
      if (created.status === "fulfilled") {
        recipeWon += 1;
        expect((adopted as PromiseRejectedResult).reason.getResponse()).toMatchObject({
          code: "RECIPE_INVALID",
          reason: "RECIPE_PRODUCT_HAS_PARENT",
        });
      } else {
        parentWon += 1;
        expect(created.reason.getResponse?.()).toMatchObject({ code: "RECIPE_INVALID" });
      }
    }
    expect(recipeWon + parentWon).toBe(6);
  }, 120_000);

  it("LOCK EDGE: activate blocks on the family lock a re-parent holds, then refuses over the re-parented component", async () => {
    const tenantId = await seedTenant("lock-edge");
    const c = await seedDraft(tenantId);
    const writer = await pool.connect();
    let serviceError: any;
    let blocked = false;
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout = '15s'");
      const pid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await writer.query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE', [c.family.id]);
      await writer.query('UPDATE "Product" SET "parentProductId" = NULL WHERE id = $1', [
        c.variants[0].id,
      ]);
      let settled = false;
      const running = inTenant(tenantId, () => recipes.activate(c.draft.id))
        .then(
          () => undefined,
          (err) => {
            serviceError = err;
          },
        )
        .finally(() => {
          settled = true;
        });
      blocked = await waitUntilBlockedBy(pid, () => settled);
      await writer.query("COMMIT");
      await running;
    } finally {
      writer.release();
    }
    expect(blocked).toBe(true);
    expect(serviceError?.getResponse?.()).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "COMPONENT_NOT_VARIANT",
    });
    const after = await prisma.recipe.findUniqueOrThrow({ where: { id: c.draft.id } });
    expect(after).toMatchObject({ status: "DRAFT", activeFor: null });
    expect(await activeRecipeHasNonFamilyComponent(tenantId)).toBe(false);
  }, 60_000);

  it("a family unitsPerBox edit with an open recipe is a 409; a RETIRED-only family may change", async () => {
    const tenantId = await seedTenant("family-upb");
    const c = await seedDraft(tenantId);
    // DRAFT recipe: open
    let err: any = await inTenant(tenantId, () =>
      products.update(c.family.id, { unitsPerBox: 24 } as any),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
    // ACTIVE recipe: open
    await inTenant(tenantId, () => recipes.activate(c.draft.id));
    err = await inTenant(tenantId, () =>
      products.update(c.family.id, { unitsPerBox: 24 } as any),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
    // the recipe product's own box size is locked too
    err = await inTenant(tenantId, () =>
      products.update(c.recipeProduct.id, { unitsPerBox: 6 } as any),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
    const family = await prisma.product.findUniqueOrThrow({ where: { id: c.family.id } });
    expect(family.unitsPerBox).toBe(12);
    // RETIRED only: another family whose only recipe is retired may change its box size
    await prisma.recipe.updateMany({
      where: { tenantId, id: c.draft.id },
      data: { status: "RETIRED", activeFor: null, retiredAt: new Date() },
    });
    await inTenant(tenantId, () => products.update(c.family.id, { unitsPerBox: 24 } as any));
    const changed = await prisma.product.findUniqueOrThrow({ where: { id: c.family.id } });
    expect(changed.unitsPerBox).toBe(24);
  }, 60_000);

  it("re-parenting a component, and adopting the recipe product or the family, are 409s while the recipe is open", async () => {
    const tenantId = await seedTenant("reparent-409");
    const c = await seedDraft(tenantId);
    const other = await product(tenantId, "Other family");
    let err: any = await inTenant(tenantId, () =>
      products.update(c.variants[0].id, { parentProductId: other.id } as any),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
    err = await inTenant(tenantId, () =>
      products.update(c.recipeProduct.id, { parentProductId: other.id } as any),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "RECIPE_INVALID" });
    err = await inTenant(tenantId, () =>
      products.update(c.family.id, { parentProductId: other.id } as any),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "FAMILY_IS_VARIANT",
    });
    const rows = await prisma.product.findMany({
      where: { id: { in: [c.variants[0].id, c.recipeProduct.id, c.family.id] } },
    });
    expect(rows.find((r) => r.id === c.variants[0].id)?.parentProductId).toBe(c.family.id);
    expect(rows.find((r) => r.id === c.recipeProduct.id)?.parentProductId).toBeNull();
    expect(rows.find((r) => r.id === c.family.id)?.parentProductId).toBeNull();
  }, 60_000);
  it("SA-584b: a since-deactivated component is cloned as-is; activate refuses the clone until it is swapped", async () => {
    const tenantId = await seedTenant("clone-inactive");
    const c = await seedDraft(tenantId);
    await inTenant(tenantId, () => recipes.activate(c.draft.id));
    await prisma.product.update({ where: { id: c.variants[1].id }, data: { isActive: false } });

    const clone = await inTenant(tenantId, () => recipes.createVersion(c.draft.id));
    expect(clone).toMatchObject({ version: 2, status: "DRAFT" });
    expect(clone.components.map((x: any) => x.componentProductId).sort()).toEqual(
      [c.variants[0].id, c.variants[1].id].sort(),
    );

    const refused: any = await inTenant(tenantId, () => recipes.activate(clone.id)).catch((e) => e);
    expect(refused.getResponse()).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "COMPONENT_INACTIVE",
    });

    await inTenant(tenantId, () =>
      recipes.update(clone.id, {
        components: [
          { componentProductId: c.variants[0].id, qty: 8 },
          { componentProductId: c.variants[2].id, qty: 4 },
        ],
      } as any),
    );
    const activated = await inTenant(tenantId, () => recipes.activate(clone.id));
    expect(activated).toMatchObject({ status: "ACTIVE" });
    const v1 = await prisma.recipe.findUniqueOrThrow({ where: { id: c.draft.id } });
    expect(v1.status).toBe("RETIRED");
  }, 60_000);

  it("SA-587a: bulk assign / unassign of a tracked category vs an open recipe is a 409 with NOTHING written", async () => {
    const tenantId = await seedTenant("category-bulk");
    const cat = await prisma.trackedCategory.create({ data: { tenantId, name: "Beverage" } });
    const target = await prisma.trackedCategory.create({ data: { tenantId, name: "Snacks" } });
    const c = await seedDraft(tenantId, { trackedCategoryId: cat.id });
    const stray = await product(tenantId, "Stray", { trackedCategoryId: cat.id });

    // assign: the component would move, the stray would too — neither may.
    let err: any = await inTenant(tenantId, () =>
      categories.assignProducts(target.id, [c.variants[0].id, stray.id]),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "RECIPE_CATEGORY_LOCKED" });
    // unassign: same, from the category they are in.
    err = await inTenant(tenantId, () =>
      categories.unassignProducts(cat.id, [c.variants[0].id, stray.id]),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "RECIPE_CATEGORY_LOCKED" });
    const rows = await prisma.product.findMany({
      where: { id: { in: [c.variants[0].id, stray.id] } },
    });
    expect(rows.map((r) => r.trackedCategoryId)).toEqual([cat.id, cat.id]);

    // RETIRED-only: the same bulk move goes through.
    await prisma.recipe.updateMany({
      where: { tenantId, id: c.draft.id },
      data: { status: "RETIRED", activeFor: null, retiredAt: new Date() },
    });
    const res = await inTenant(tenantId, () =>
      categories.assignProducts(target.id, [c.variants[0].id, stray.id]),
    );
    expect(res).toMatchObject({ assigned: 2 });
  }, 60_000);
});
