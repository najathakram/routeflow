import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RecipesService } from "./recipes.service";
import { propagateFamilyPrice } from "./family-price";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-584 B1/B2 (#2717 M2 fold): the HOUSE LOCK ORDER is FAMILY row -> recipe-product row ->
 * variant/component rows (id order), and a recipe write re-validates its shape INSIDE the tx, after
 * the locks, reading through `tx` (L-239: lock first, decide on what is read after it).
 *
 * The harness gives the recipe service two distinct surfaces: `outer` (forTenant(), the pre-tx
 * reads) and `tx` (the transaction client). Every call is logged with its surface, and the raw lock
 * statements are logged as `lock:update:<id>` / `lock:share:<id>`.
 */
type Row = Record<string, any>;

const FAMILY = {
  id: "fam",
  parentProductId: null,
  kind: "STANDARD",
  isActive: true,
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  unitsPerBox: 12,
  familyPriceOverride: false,
};
const variant = (id: string, over: Row = {}) => ({
  ...FAMILY,
  id,
  parentProductId: "fam",
  ...over,
});

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "tenantId") return true;
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return (cond.in as unknown[]).includes(row[key]);
      if ("not" in cond) return row[key] !== cond.not;
    }
    return row[key] === cond;
  });

function makeHarness(seed: { products: Row[]; recipes: Row[]; components: Row[] }) {
  const products = seed.products.map((p) => ({ ...p }));
  const recipes = seed.recipes.map((r) => ({ ...r }));
  const components = seed.components.map((c) => ({ ...c }));
  const events: string[] = [];
  let seq = 0;

  const surface = (tag: "outer" | "tx") => {
    const track = (name: string, fn: (...a: any[]) => any) =>
      jest.fn(async (...args: any[]) => {
        events.push(`${tag}:${name}`);
        return fn(...args);
      });
    const withComponents = (r: Row | undefined, include?: Row) =>
      r && include?.components
        ? { ...r, components: components.filter((c) => c.recipeId === r.id) }
        : r;
    return {
      product: {
        findFirst: track("product.findFirst", ({ where }) =>
          products.find((p) => matches(p, where)),
        ),
        findMany: track("product.findMany", ({ where }) =>
          products.filter((p) => matches(p, where)),
        ),
        count: track(
          "product.count",
          ({ where }) => products.filter((p) => matches(p, where)).length,
        ),
        update: track("product.update", ({ where, data }) => {
          const row = products.find((p) => p.id === where.id)!;
          Object.assign(row, data);
          return row;
        }),
      },
      recipe: {
        findFirst: track("recipe.findFirst", ({ where, include }) =>
          withComponents(
            recipes.find((r) => matches(r, where)),
            include,
          ),
        ),
        findMany: track("recipe.findMany", ({ where }) => recipes.filter((r) => matches(r, where))),
        aggregate: track("recipe.aggregate", () => ({ _max: { version: 1 } })),
        create: track("recipe.create", ({ data }) => {
          const row = { id: `new-r${++seq}`, retiredAt: null, effectiveFrom: null, ...data };
          recipes.push(row);
          return row;
        }),
        updateMany: track("recipe.updateMany", ({ where, data }) => {
          const hit = recipes.filter((r) => matches(r, where));
          hit.forEach((r) => Object.assign(r, data));
          return { count: hit.length };
        }),
        update: track("recipe.update", ({ where, data }) => {
          const row = recipes.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return row;
        }),
      },
      recipeComponent: {
        findMany: track("recipeComponent.findMany", ({ where }) =>
          components.filter((c) => matches(c, where)).sort((a, b) => a.position - b.position),
        ),
        count: track(
          "recipeComponent.count",
          ({ where }) => components.filter((c) => matches(c, where)).length,
        ),
        createMany: track("recipeComponent.createMany", ({ data }) => {
          for (const d of data) components.push({ id: `new-c${++seq}`, ...d });
          return { count: data.length };
        }),
        deleteMany: track("recipeComponent.deleteMany", ({ where }) => {
          const keep = components.filter((c) => !matches(c, where));
          const removed = components.length - keep.length;
          components.splice(0, components.length, ...keep);
          return { count: removed };
        }),
      },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        const kind = /FOR SHARE/i.test(sql) ? "share" : /FOR UPDATE/i.test(sql) ? "update" : "raw";
        events.push(`${tag}:lock:${kind}:${String(values[0])}`);
        return [];
      }),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
  };

  const outer = surface("outer");
  const tx = surface("tx");
  const prisma = createMockPrisma();
  prisma.forTenant.mockReturnValue(outer as any);
  prisma.tenantTransaction.mockImplementation(async (fn: any) => {
    events.push("tx:start");
    return fn(tx);
  });
  return { prisma, products, recipes, components, events, tx };
}

async function build(seed: Parameters<typeof makeHarness>[0]) {
  const h = makeHarness(seed);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RecipesService,
      { provide: PrismaService, useValue: h.prisma },
      {
        provide: FeatureConfigService,
        useValue: { getEffectiveMode: jest.fn().mockResolvedValue("on") },
      },
    ],
  }).compile();
  return { service: module.get(RecipesService), ...h };
}

const products = () => [
  { ...FAMILY },
  { ...FAMILY, id: "rp" },
  variant("v1"),
  variant("v2"),
  variant("v3"),
];
const recipeRow = (status: string) => ({
  id: "r1",
  tenantId: "test-tenant",
  productId: "rp",
  familyProductId: "fam",
  version: 1,
  unitsPerPack: 12,
  status,
  activeFor: status === "ACTIVE" ? "rp" : null,
});
const seedDraft = () => ({
  products: products(),
  recipes: [recipeRow("DRAFT")],
  components: [
    {
      id: "c1",
      tenantId: "test-tenant",
      recipeId: "r1",
      componentProductId: "v1",
      qty: 8,
      position: 0,
    },
    {
      id: "c2",
      tenantId: "test-tenant",
      recipeId: "r1",
      componentProductId: "v2",
      qty: 4,
      position: 1,
    },
  ],
});
const bodyOf = (err: any) => err.getResponse();

const lockEvents = (events: string[]) => events.filter((e) => e.startsWith("tx:lock:"));
const firstTxProductRead = (events: string[]) =>
  events.findIndex((e) => e.startsWith("tx:product.find") || e === "tx:product.count");
const lastLockIndex = (events: string[]) => {
  let last = -1;
  events.forEach((e, i) => {
    if (e.startsWith("tx:lock:")) last = i;
  });
  return last;
};

describe("house lock order: recipe writers (SA-584 B1/B2)", () => {
  it("create: family, recipe product, then the components FOR SHARE in id order; shape re-read via tx after them", async () => {
    const { service, events } = await build({ products: products(), recipes: [], components: [] });
    await service.create({
      recipeProductId: "rp",
      familyProductId: "fam",
      unitsPerPack: 12,
      components: [
        { componentProductId: "v2", qty: 4 },
        { componentProductId: "v1", qty: 8 },
      ],
    } as any);
    expect(lockEvents(events)).toEqual([
      "tx:lock:update:fam",
      "tx:lock:update:rp",
      "tx:lock:share:v1",
      "tx:lock:share:v2",
    ]);
    const firstRead = firstTxProductRead(events);
    expect(firstRead).toBeGreaterThan(lastLockIndex(events));
  });

  it("create: a component re-parented between the pre-read and the locks -> 400 COMPONENT_NOT_VARIANT, nothing written", async () => {
    const {
      service,
      prisma,
      products: rows,
      recipes,
    } = await build({
      products: products(),
      recipes: [],
      components: [],
    });
    const original = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      rows.find((p) => p.id === "v1")!.parentProductId = null;
      return original(fn);
    });
    const err = await service
      .create({
        recipeProductId: "rp",
        familyProductId: "fam",
        unitsPerPack: 12,
        components: [
          { componentProductId: "v1", qty: 8 },
          { componentProductId: "v2", qty: 4 },
        ],
      } as any)
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "COMPONENT_NOT_VARIANT" });
    expect(recipes).toHaveLength(0);
  });

  it("update (new components): family, recipe product, shares in id order, re-validation via tx after them", async () => {
    const { service, events } = await build(seedDraft());
    await service.update("r1", {
      components: [
        { componentProductId: "v3", qty: 6 },
        { componentProductId: "v1", qty: 6 },
      ],
    } as any);
    expect(lockEvents(events)).toEqual([
      "tx:lock:update:fam",
      "tx:lock:update:rp",
      "tx:lock:share:v1",
      "tx:lock:share:v3",
    ]);
    expect(firstTxProductRead(events)).toBeGreaterThan(lastLockIndex(events));
  });

  it("update (unitsPerPack only): the shares cover the recipe's current components, read under the recipe lock", async () => {
    const { service, events } = await build(seedDraft());
    await service.update("r1", { unitsPerPack: 12 } as any);
    expect(lockEvents(events)).toEqual([
      "tx:lock:update:fam",
      "tx:lock:update:rp",
      "tx:lock:share:v1",
      "tx:lock:share:v2",
    ]);
  });

  it("update: a component re-parented between the pre-read and the locks -> 400, rows untouched", async () => {
    const { service, prisma, products: rows, components } = await build(seedDraft());
    const original = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      rows.find((p) => p.id === "v3")!.parentProductId = null;
      return original(fn);
    });
    const err = await service
      .update("r1", {
        components: [
          { componentProductId: "v1", qty: 6 },
          { componentProductId: "v3", qty: 6 },
        ],
      } as any)
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "COMPONENT_NOT_VARIANT" });
    expect(components.map((c) => c.componentProductId)).toEqual(["v1", "v2"]);
  });

  it("activate: family, recipe product, shares in id order, then the shape is re-read via tx", async () => {
    const { service, events } = await build(seedDraft());
    await service.activate("r1");
    expect(lockEvents(events)).toEqual([
      "tx:lock:update:fam",
      "tx:lock:update:rp",
      "tx:lock:share:v1",
      "tx:lock:share:v2",
    ]);
    expect(firstTxProductRead(events)).toBeGreaterThan(lastLockIndex(events));
  });

  it("activate refuses a component that was re-parented out of the family since DRAFT (I2)", async () => {
    const { service, products: rows, recipes } = await build(seedDraft());
    rows.find((p) => p.id === "v1")!.parentProductId = null;
    const err = await service.activate("r1").catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "COMPONENT_NOT_VARIANT" });
    expect(recipes[0]).toMatchObject({ status: "DRAFT", activeFor: null });
  });

  it("activate refuses a component that was deactivated since DRAFT", async () => {
    const { service, products: rows, recipes } = await build(seedDraft());
    rows.find((p) => p.id === "v2")!.isActive = false;
    const err = await service.activate("r1").catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "COMPONENT_INACTIVE" });
    expect(recipes[0].status).toBe("DRAFT");
  });

  it("activate refuses a family that changed its box size since DRAFT (Q10)", async () => {
    const { service, products: rows, recipes } = await build(seedDraft());
    rows.find((p) => p.id === "fam")!.unitsPerBox = 24;
    const err = await service.activate("r1").catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "PACK_SIZE_MISMATCH" });
    expect(recipes[0].status).toBe("DRAFT");
  });

  it("activate re-validates under the locks: a re-parent that lands between the plan read and the tx is caught", async () => {
    const { service, prisma, products: rows, recipes } = await build(seedDraft());
    const original = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      rows.find((p) => p.id === "v1")!.parentProductId = "other";
      return original(fn);
    });
    const err = await service.activate("r1").catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "COMPONENT_NOT_VARIANT" });
    expect(recipes[0].status).toBe("DRAFT");
  });
});

describe("createVersion clones AS-IS under the locks: NO shape validation (SA-584b; activate is the gate)", () => {
  const seedActive = () => ({ ...seedDraft(), recipes: [recipeRow("ACTIVE")] });

  it("locks family, recipe product, then the source's components FOR SHARE in id order, and reads no product shape", async () => {
    const { service, events } = await build(seedActive());
    await service.createVersion("r1");
    expect(lockEvents(events)).toEqual([
      "tx:lock:update:fam",
      "tx:lock:update:rp",
      "tx:lock:share:v1",
      "tx:lock:share:v2",
    ]);
    expect(firstTxProductRead(events)).toBe(-1);
  });

  it("a component re-parented since the source was validated is cloned AS-IS too: the DRAFT is created (SA-584b)", async () => {
    const { service, products: rows, recipes } = await build(seedActive());
    rows.find((p) => p.id === "v1")!.parentProductId = null;
    await expect(service.createVersion("r1")).resolves.toMatchObject({
      version: 2,
      status: "DRAFT",
    });
    expect(recipes).toHaveLength(2);
  });

  it("SA-584b path (re-parent): clone 201 -> activate 400 -> fix the DRAFT -> activate 200, v1 RETIRED", async () => {
    const { service, products: rows, recipes } = await build(seedActive());
    rows.find((p) => p.id === "v1")!.parentProductId = null;
    const draft = await service.createVersion("r1");
    const refused = await service.activate(draft.id).catch((e) => e);
    expect(bodyOf(refused)).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "COMPONENT_NOT_VARIANT",
    });
    expect(recipes.find((r) => r.id === "r1")!.status).toBe("ACTIVE");
    await service.update(draft.id, {
      components: [
        { componentProductId: "v2", qty: 8 },
        { componentProductId: "v3", qty: 4 },
      ],
    } as any);
    await expect(service.activate(draft.id)).resolves.toMatchObject({ status: "ACTIVE" });
    expect(recipes.find((r) => r.id === "r1")!.status).toBe("RETIRED");
  });

  it("SA-584b path (category moved by tracked-categories assign): clone 201 -> activate 400 -> fix -> 200", async () => {
    const { service, products: rows, recipes } = await build(seedActive());
    rows.find((p) => p.id === "v1")!.trackedCategoryId = "cat-2";
    const draft = await service.createVersion("r1");
    const refused = await service.activate(draft.id).catch((e) => e);
    expect(bodyOf(refused)).toMatchObject({ code: "RECIPE_INVALID", reason: "CATEGORY_MISMATCH" });
    rows.find((p) => p.id === "v1")!.trackedCategoryId = "cat-1";
    await expect(service.activate(draft.id)).resolves.toMatchObject({ status: "ACTIVE" });
    expect(recipes.find((r) => r.id === "r1")!.status).toBe("RETIRED");
  });

  it("a component deactivated since the source was validated is cloned AS-IS: the DRAFT is created (SA-584b)", async () => {
    const { service, products: rows, recipes, components } = await build(seedActive());
    rows.find((p) => p.id === "v2")!.isActive = false;
    const dto = await service.createVersion("r1");
    expect(dto).toMatchObject({ version: 2, status: "DRAFT" });
    expect(recipes).toHaveLength(2);
    expect(
      components
        .filter((c) => c.recipeId === dto.id)
        .map((c) => [c.componentProductId, c.qty])
        .sort(),
    ).toEqual([
      ["v1", 8],
      ["v2", 4],
    ]);
  });

  it("a component deactivated between the plan read and the tx is cloned AS-IS too (no re-check refusal)", async () => {
    const { service, prisma, products: rows, recipes } = await build(seedActive());
    const original = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      rows.find((p) => p.id === "v2")!.isActive = false;
      return original(fn);
    });
    await expect(service.createVersion("r1")).resolves.toMatchObject({ status: "DRAFT" });
    expect(recipes).toHaveLength(2);
  });

  it("SA-584b path: deactivate -> clone (201) -> activate the clone refuses -> swap in the DRAFT -> activate (200), v1 RETIRED", async () => {
    const { service, products: rows, recipes } = await build(seedActive());
    rows.find((p) => p.id === "v2")!.isActive = false;
    const draft = await service.createVersion("r1");
    expect(draft).toMatchObject({ version: 2, status: "DRAFT" });

    const refused = await service.activate(draft.id).catch((e) => e);
    expect(bodyOf(refused)).toMatchObject({ code: "RECIPE_INVALID", reason: "COMPONENT_INACTIVE" });
    expect(recipes.find((r) => r.id === draft.id)!.status).toBe("DRAFT");
    expect(recipes.find((r) => r.id === "r1")!.status).toBe("ACTIVE");

    await service.update(draft.id, {
      components: [
        { componentProductId: "v1", qty: 8 },
        { componentProductId: "v3", qty: 4 },
      ],
    } as any);
    const active = await service.activate(draft.id);
    expect(active).toMatchObject({ status: "ACTIVE" });
    expect(recipes.find((r) => r.id === "r1")!.status).toBe("RETIRED");
    expect(recipes.find((r) => r.id === draft.id)!.status).toBe("ACTIVE");
  });
});

describe("update: the under-lock DRAFT re-check decides (lead fold item 2)", () => {
  it("a unitsPerPack-only edit of a recipe that went ACTIVE between the read and the lock -> 409 RECIPE_IMMUTABLE, no recipe.update", async () => {
    const { service, prisma, recipes, tx } = await build(seedDraft());
    const original = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      recipes[0].status = "ACTIVE";
      return original(fn);
    });
    const err = await service.update("r1", { unitsPerPack: 12 } as any).catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_IMMUTABLE" });
    expect(tx.recipe.update).not.toHaveBeenCalled();
    expect(recipes[0].unitsPerPack).toBe(12);
  });

  it("the status is re-read AFTER the locks, through tx (the observation the decision rests on)", async () => {
    const { service, events } = await build(seedDraft());
    await service.update("r1", { unitsPerPack: 12 } as any);
    const lastLock = lastLockIndex(events);
    const statusRead = events.findIndex((e, i) => i > lastLock && e === "tx:recipe.findFirst");
    expect(statusRead).toBeGreaterThan(lastLock);
  });
});

describe("house lock order: propagateFamilyPrice (recipe products before variants)", () => {
  it("writes recipe products BEFORE variants (family -> recipe product -> variants)", async () => {
    const calls: string[] = [];
    const tx: any = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          pricePerUnit: "10",
          priceTier2: "9",
          priceTier3: "8",
          priceTier4: "7",
          priceTier5: "6",
        }),
        updateMany: jest.fn(async (args: any) => {
          calls.push(args.where.parentProductId ? "variants" : "recipes");
          return { count: 1 };
        }),
      },
      recipe: { findMany: jest.fn().mockResolvedValue([{ productId: "rp" }]) },
      auditLog: { create: jest.fn() },
    };
    await propagateFamilyPrice(tx, { tenantId: "t", familyId: "fam" });
    expect(calls).toEqual(["recipes", "variants"]);
  });
});

describe("house lock order: documented once, where the lock helpers live", () => {
  it("product-catalog-sync.ts states the order and offers a FOR SHARE component lock", () => {
    const text = readFileSync(join(__dirname, "product-catalog-sync.ts"), "utf8");
    expect(text).toContain("HOUSE LOCK ORDER");
    expect(text).toMatch(/FAMILY[^\n]*recipe[- ]product[^\n]*variant\/component/i);
    expect(text).toContain("lockProductRowsShared");
    expect(text).toMatch(/FOR SHARE/);
  });
});
