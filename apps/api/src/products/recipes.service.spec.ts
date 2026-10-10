import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RecipesService } from "./recipes.service";
import { recipeUniqueViolation } from "./recipe-rules";

/**
 * #2717 M2 tests 1-8 plus SA-579 (recipe component rows of a non-DRAFT recipe are immutable).
 * A small in-memory Product/Recipe/RecipeComponent store sits behind the mocked Prisma so the
 * assertions are about behaviour (rows written, statuses, statuses refused), not call shapes.
 * `events` records every model call and the tx lock in order, for the source-order pin (L-239).
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
const RECIPE_PRODUCT = { ...FAMILY, id: "rp", unitsPerBox: 12 };
const variant = (id: string, over: Row = {}) => ({
  ...FAMILY,
  id,
  parentProductId: "fam",
  ...over,
});

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return (cond.in as unknown[]).includes(row[key]);
      if ("not" in cond) return row[key] !== cond.not;
    }
    return row[key] === cond;
  });

function makeStore(seed: { products: Row[]; recipes?: Row[]; components?: Row[] }) {
  const products = seed.products.map((p) => ({ ...p }));
  const recipes = (seed.recipes ?? []).map((r) => ({ ...r }));
  const components = (seed.components ?? []).map((c) => ({ ...c }));
  const events: string[] = [];
  let seq = 0;
  const track = <T extends (...args: any[]) => any>(name: string, fn: T): jest.Mock =>
    jest.fn(async (...args: any[]) => {
      events.push(name);
      return fn(...args);
    });

  const withComponents = (r: Row | undefined, include?: Row) =>
    r && include?.components
      ? {
          ...r,
          components: components
            .filter((c) => c.recipeId === r.id)
            .sort((a, b) => a.position - b.position),
        }
      : r;

  const prisma = createMockPrisma();
  prisma.product.findFirst = track("product.findFirst", ({ where }: any) =>
    products.find((p) => matches(p, where)),
  ) as any;
  prisma.product.findMany = track("product.findMany", ({ where }: any) =>
    products.filter((p) => matches(p, where)),
  ) as any;
  prisma.product.count = track(
    "product.count",
    ({ where }: any) => products.filter((p) => matches(p, where)).length,
  ) as any;
  prisma.product.update = track("product.update", ({ where, data }: any) => {
    const row = products.find((p) => p.id === where.id)!;
    Object.assign(row, data);
    return row;
  }) as any;
  prisma.recipe.findFirst = track("recipe.findFirst", ({ where, include }: any) =>
    withComponents(
      recipes.find((r) => matches(r, where)),
      include,
    ),
  ) as any;
  prisma.recipe.findMany = track("recipe.findMany", ({ where, include }: any) =>
    recipes.filter((r) => matches(r, where)).map((r) => withComponents(r, include)),
  ) as any;
  prisma.recipe.aggregate = track("recipe.aggregate", ({ where }: any) => ({
    _max: {
      version:
        Math.max(0, ...recipes.filter((r) => matches(r, where)).map((r) => r.version)) || null,
    },
  })) as any;
  prisma.recipe.create = track("recipe.create", ({ data }: any) => {
    const row = { id: `new-r${++seq}`, retiredAt: null, effectiveFrom: null, ...data };
    recipes.push(row);
    return row;
  }) as any;
  prisma.recipe.updateMany = track("recipe.updateMany", ({ where, data }: any) => {
    const hit = recipes.filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  }) as any;
  prisma.recipe.update = track("recipe.update", ({ where, data }: any) => {
    const row = recipes.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return row;
  }) as any;
  prisma.recipeComponent.findMany = track("recipeComponent.findMany", ({ where }: any) =>
    components.filter((c) => matches(c, where)).sort((a, b) => a.position - b.position),
  ) as any;
  prisma.recipeComponent.count = track(
    "recipeComponent.count",
    ({ where }: any) => components.filter((c) => matches(c, where)).length,
  ) as any;
  prisma.recipeComponent.createMany = track("recipeComponent.createMany", ({ data }: any) => {
    for (const d of data) components.push({ id: `new-c${++seq}`, ...d });
    return { count: data.length };
  }) as any;
  prisma.recipeComponent.deleteMany = track("recipeComponent.deleteMany", ({ where }: any) => {
    const keep = components.filter((c) => !matches(c, where));
    const removed = components.length - keep.length;
    components.splice(0, components.length, ...keep);
    return { count: removed };
  }) as any;
  prisma.recipeComponent.updateMany = track("recipeComponent.updateMany", () => ({
    count: 0,
  })) as any;
  prisma.recipeComponent.update = track("recipeComponent.update", () => ({})) as any;
  prisma.recipeComponent.delete = track("recipeComponent.delete", () => ({})) as any;
  prisma.recipeComponent.upsert = track("recipeComponent.upsert", () => ({})) as any;

  const tx = {
    ...prisma,
    $queryRaw: jest.fn(async () => {
      events.push("lock");
      return [];
    }),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  prisma.tenantTransaction.mockImplementation(async (fn: any) => {
    events.push("tx:start");
    return fn(tx);
  });
  prisma.forTenant.mockReturnValue(prisma as any);
  return { prisma, tx, products, recipes, components, events };
}

async function build(mode: "on" | "off", seed: Parameters<typeof makeStore>[0]) {
  const store = makeStore(seed);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RecipesService,
      { provide: PrismaService, useValue: store.prisma },
      {
        provide: FeatureConfigService,
        useValue: { getEffectiveMode: jest.fn().mockResolvedValue(mode) },
      },
    ],
  }).compile();
  return { service: module.get(RecipesService), ...store };
}

const seedProducts = () => [
  { ...FAMILY },
  { ...RECIPE_PRODUCT },
  variant("v1"),
  variant("v2"),
  variant("v3"),
];
const createDto = (over: Row = {}) => ({
  recipeProductId: "rp",
  familyProductId: "fam",
  unitsPerPack: 12,
  components: [
    { componentProductId: "v1", qty: 8 },
    { componentProductId: "v2", qty: 4 },
  ],
  ...over,
});
const bodyOf = (err: any) => err.getResponse();

describe("RecipesService.create (tests 1-5)", () => {
  it("1: creates DRAFT v1 with no activeFor and marks the product RECIPE", async () => {
    const { service, recipes, components, products } = await build("on", {
      products: seedProducts(),
    });
    const dto = await service.create(createDto() as any, "user-1");
    expect(dto).toMatchObject({
      productId: "rp",
      familyProductId: "fam",
      version: 1,
      unitsPerPack: 12,
      status: "DRAFT",
      activeFor: null,
    });
    expect(dto.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      ["v1", 8],
      ["v2", 4],
    ]);
    expect(recipes[0]).toMatchObject({ tenantId: "test-tenant", createdById: "user-1" });
    expect(components.every((c) => c.tenantId === "test-tenant")).toBe(true);
    expect(products.find((p) => p.id === "rp")!.kind).toBe("RECIPE");
  });

  const invalid: Array<[string, Row, string]> = [
    [
      "a component that is not a variant of the family",
      {
        components: [
          { componentProductId: "loose", qty: 8 },
          { componentProductId: "v2", qty: 4 },
        ],
      },
      "COMPONENT_NOT_VARIANT",
    ],
    [
      "a quantity sum that is not unitsPerPack",
      {
        components: [
          { componentProductId: "v1", qty: 8 },
          { componentProductId: "v2", qty: 3 },
        ],
      },
      "QTY_SUM_MISMATCH",
    ],
    [
      "a zero quantity",
      {
        components: [
          { componentProductId: "v1", qty: 0 },
          { componentProductId: "v2", qty: 12 },
        ],
      },
      "QTY_INVALID",
    ],
    [
      "a negative quantity",
      {
        components: [
          { componentProductId: "v1", qty: -1 },
          { componentProductId: "v2", qty: 13 },
        ],
      },
      "QTY_INVALID",
    ],
    [
      "a fractional quantity",
      {
        components: [
          { componentProductId: "v1", qty: 1.5 },
          { componentProductId: "v2", qty: 10.5 },
        ],
      },
      "QTY_INVALID",
    ],
    [
      "a duplicate component",
      {
        components: [
          { componentProductId: "v1", qty: 6 },
          { componentProductId: "v1", qty: 6 },
        ],
      },
      "DUPLICATE_COMPONENT",
    ],
    ["no components", { components: [] }, "NO_COMPONENTS"],
    [
      "a component that is itself a recipe product",
      {
        components: [
          { componentProductId: "vr", qty: 8 },
          { componentProductId: "v2", qty: 4 },
        ],
      },
      "COMPONENT_IS_RECIPE",
    ],
    [
      "an inactive component",
      {
        components: [
          { componentProductId: "vi", qty: 8 },
          { componentProductId: "v2", qty: 4 },
        ],
      },
      "COMPONENT_INACTIVE",
    ],
    [
      "a component that does not exist in this tenant",
      {
        components: [
          { componentProductId: "ghost", qty: 8 },
          { componentProductId: "v2", qty: 4 },
        ],
      },
      "COMPONENT_NOT_FOUND",
    ],
    [
      "a component in another tracked category (I6)",
      {
        components: [
          { componentProductId: "vc", qty: 8 },
          { componentProductId: "v2", qty: 4 },
        ],
      },
      "CATEGORY_MISMATCH",
    ],
  ];
  it.each(invalid)("2: %s -> 400 RECIPE_INVALID", async (_label, over, reason) => {
    const { service, recipes } = await build("on", {
      products: [
        ...seedProducts(),
        { ...FAMILY, id: "loose" },
        variant("vr", { kind: "RECIPE" }),
        variant("vi", { isActive: false }),
        variant("vc", { trackedCategoryId: "cat-2" }),
      ],
    });
    const err = await service.create(createDto(over) as any).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason });
    expect(recipes).toHaveLength(0);
  });

  it("3: a recipe product that has a parent -> 409", async () => {
    const { service } = await build("on", {
      products: [
        { ...FAMILY },
        { ...RECIPE_PRODUCT, parentProductId: "fam" },
        variant("v1"),
        variant("v2"),
      ],
    });
    const err = await service.create(createDto() as any).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(bodyOf(err)).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "RECIPE_PRODUCT_HAS_PARENT",
    });
  });

  it("3: a recipe product that has variants -> 409", async () => {
    const { service } = await build("on", {
      products: [...seedProducts(), variant("kid", { parentProductId: "rp" })],
    });
    const err = await service.create(createDto() as any).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(bodyOf(err)).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "RECIPE_PRODUCT_HAS_VARIANTS",
    });
  });

  it("3: a recipe product that is already the recipe of another family -> 409", async () => {
    const { service } = await build("on", {
      products: seedProducts(),
      recipes: [
        {
          id: "old",
          tenantId: "test-tenant",
          productId: "rp",
          familyProductId: "other",
          version: 1,
          status: "DRAFT",
        },
      ],
    });
    const err = await service.create(createDto() as any).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(bodyOf(err)).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "RECIPE_PRODUCT_HAS_RECIPE",
    });
  });

  it("3: a family that is itself a variant -> 400", async () => {
    const { service } = await build("on", {
      products: [
        { ...FAMILY, parentProductId: "grand" },
        { ...RECIPE_PRODUCT },
        variant("v1"),
        variant("v2"),
      ],
    });
    const err = await service.create(createDto() as any).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "FAMILY_IS_VARIANT" });
  });

  it("3: an unknown recipe product or family -> 404", async () => {
    const { service } = await build("on", { products: seedProducts() });
    await expect(
      service.create(createDto({ recipeProductId: "nope" }) as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.create(createDto({ familyProductId: "nope" }) as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("5 (Q10): unitsPerPack must equal the family's unitsPerBox unless the recipe product overrides the price", async () => {
    const ten = createDto({
      unitsPerPack: 10,
      components: [
        { componentProductId: "v1", qty: 6 },
        { componentProductId: "v2", qty: 4 },
      ],
    });
    const plain = await build("on", { products: seedProducts() });
    const err = await plain.service.create(ten as any).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "PACK_SIZE_MISMATCH" });

    const overridden = await build("on", {
      products: [
        { ...FAMILY },
        { ...RECIPE_PRODUCT, familyPriceOverride: true },
        variant("v1"),
        variant("v2"),
      ],
    });
    await expect(overridden.service.create(ten as any)).resolves.toMatchObject({
      unitsPerPack: 10,
    });

    const equal = await build("on", { products: seedProducts() });
    await expect(equal.service.create(createDto() as any)).resolves.toMatchObject({
      unitsPerPack: 12,
    });
  });

  it("8 (Q6): every route is mode-gated — off refuses 403 before any read, on works", async () => {
    const off = await build("off", { products: seedProducts() });
    await expect(off.service.create(createDto() as any)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(off.service.activate("r1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(off.service.createVersion("r1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(off.service.update("r1", {} as any)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(off.service.findOne("r1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(off.events).toEqual([]);
    const on = await build("on", { products: seedProducts() });
    await expect(on.service.create(createDto() as any)).resolves.toBeDefined();
  });
});

const seedRecipes = (status: "DRAFT" | "ACTIVE" | "RETIRED", version = 1) => ({
  products: seedProducts(),
  recipes: [
    {
      id: "r1",
      tenantId: "test-tenant",
      productId: "rp",
      familyProductId: "fam",
      version,
      unitsPerPack: 12,
      status,
      activeFor: status === "ACTIVE" ? "rp" : null,
    },
  ],
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

describe("RecipesService immutability (test 6, SA-579)", () => {
  const editDto = {
    unitsPerPack: 12,
    components: [{ componentProductId: "v1", qty: 12 }],
  };

  it.each(["ACTIVE", "RETIRED"] as const)(
    "6: PATCH on a %s recipe -> 409 RECIPE_IMMUTABLE and no component row is written",
    async (status) => {
      const { service, prisma, components } = await build("on", seedRecipes(status));
      const err = await service.update("r1", editDto as any).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ code: "RECIPE_IMMUTABLE" });
      for (const method of [
        "createMany",
        "deleteMany",
        "updateMany",
        "update",
        "delete",
        "upsert",
      ]) {
        expect((prisma.recipeComponent as any)[method]).not.toHaveBeenCalled();
      }
      expect(components).toHaveLength(2);
      expect(prisma.recipe.update).not.toHaveBeenCalled();
    },
  );

  it("6: a DRAFT recipe stays editable (components replaced, unitsPerPack kept)", async () => {
    const { service, components } = await build("on", seedRecipes("DRAFT"));
    const dto = await service.update("r1", {
      components: [
        { componentProductId: "v1", qty: 6 },
        { componentProductId: "v3", qty: 6 },
      ],
    } as any);
    expect(dto.components.map((c) => [c.componentProductId, c.qty])).toEqual([
      ["v1", 6],
      ["v3", 6],
    ]);
    expect(components.map((c) => c.componentProductId).sort()).toEqual(["v1", "v3"]);
  });

  it("6: an edit of a DRAFT still runs the I2 rules (sum must match)", async () => {
    const { service, components } = await build("on", seedRecipes("DRAFT"));
    const err = await service
      .update("r1", { components: [{ componentProductId: "v1", qty: 5 }] } as any)
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "QTY_SUM_MISMATCH" });
    expect(components).toHaveLength(2);
  });

  it("6: a recipe that goes non-DRAFT between the read and the tx still refuses (status re-read under the lock)", async () => {
    const { service, recipes, components } = await build("on", seedRecipes("DRAFT"));
    const original = (service as any).prisma.tenantTransaction.getMockImplementation();
    (service as any).prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      recipes[0].status = "ACTIVE";
      return original(fn);
    });
    const err = await service.update("r1", editDto as any).catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_IMMUTABLE" });
    expect(components).toHaveLength(2);
  });

  it("6: POST versions clones any status into DRAFT v+1 with the same components", async () => {
    const { service, recipes, components } = await build("on", seedRecipes("ACTIVE"));
    const dto = await service.createVersion("r1");
    expect(dto).toMatchObject({ version: 2, status: "DRAFT", activeFor: null, unitsPerPack: 12 });
    expect(dto.components.map((c) => [c.componentProductId, c.qty, c.position])).toEqual([
      ["v1", 8, 0],
      ["v2", 4, 1],
    ]);
    expect(recipes.find((r) => r.id === "r1")!.status).toBe("ACTIVE");
    expect(components.filter((c) => c.recipeId === "r1")).toHaveLength(2);
  });
});

describe("RecipesService.activate (test 7)", () => {
  it("7: retires the prior ACTIVE and activates the new one, in one $transaction", async () => {
    const seed = seedRecipes("ACTIVE");
    seed.recipes.push({
      id: "r2",
      tenantId: "test-tenant",
      productId: "rp",
      familyProductId: "fam",
      version: 2,
      unitsPerPack: 12,
      status: "DRAFT",
      activeFor: null,
    });
    seed.components.push({
      id: "c3",
      tenantId: "test-tenant",
      recipeId: "r2",
      componentProductId: "v1",
      qty: 12,
      position: 0,
    });
    const { service, prisma, recipes } = await build("on", seed);
    const dto = await service.activate("r2");
    expect(dto).toMatchObject({ status: "ACTIVE", activeFor: "rp" });
    expect(dto.effectiveFrom).toEqual(expect.any(String));
    const prior = recipes.find((r) => r.id === "r1")!;
    expect(prior).toMatchObject({ status: "RETIRED", activeFor: null });
    expect(prior.retiredAt).toBeInstanceOf(Date);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("7: the recipe Product row lock is the FIRST statement in the tx, before any recipe read (L-239)", async () => {
    const seed = seedRecipes("DRAFT");
    const { service, events } = await build("on", seed);
    await service.activate("r1");
    const start = events.indexOf("tx:start");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(events[start + 1]).toBe("lock");
    const firstRecipeRead = events.findIndex((e, i) => i > start && e.startsWith("recipe."));
    expect(firstRecipeRead).toBeGreaterThan(start + 1);
  });

  it("7: a recipe with no components cannot be activated", async () => {
    const seed = seedRecipes("DRAFT");
    seed.components.length = 0;
    const { service, recipes } = await build("on", seed);
    const err = await service.activate("r1").catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "NO_COMPONENTS" });
    expect(recipes[0].status).toBe("DRAFT");
  });

  it("7: activating a recipe that is not DRAFT -> 409 RECIPE_IMMUTABLE", async () => {
    const { service } = await build("on", seedRecipes("RETIRED"));
    const err = await service.activate("r1").catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_IMMUTABLE" });
  });

  it("7: a competing activation that landed between read and lock -> 409 RECIPE_ACTIVE_CONFLICT", async () => {
    const seed = seedRecipes("DRAFT");
    const { service, recipes, prisma } = await build("on", seed);
    recipes.push({
      id: "rival",
      tenantId: "test-tenant",
      productId: "rp",
      familyProductId: "fam",
      version: 2,
      unitsPerPack: 12,
      status: "DRAFT",
      activeFor: null,
    });
    const original = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      const rival = recipes.find((r) => r.id === "rival")!;
      rival.status = "ACTIVE";
      rival.activeFor = "rp";
      return original(fn);
    });
    const err = await service.activate("r1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_ACTIVE_CONFLICT" });
    expect(recipes.find((r) => r.id === "r1")!.status).toBe("DRAFT");
  });

  it("7: a raw unique violation on activeFor is mapped, never surfaced raw", async () => {
    const { service, prisma } = await build("on", seedRecipes("DRAFT"));
    prisma.recipe.updateMany.mockRejectedValueOnce(
      Object.assign(Object.create(Prisma.PrismaClientKnownRequestError.prototype), {
        code: "P2002",
        meta: { driverAdapterError: { cause: { constraint: { fields: ["activeFor"] } } } },
        message: "Unique constraint failed",
      }),
    );
    const err = await service.activate("r1").catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_ACTIVE_CONFLICT" });
  });

  it("11: a new-version race lost on the version number -> 409 RECIPE_VERSION_CONFLICT", async () => {
    const { service, recipes, prisma } = await build("on", seedRecipes("ACTIVE"));
    const original = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      recipes.push({
        id: "winner",
        tenantId: "test-tenant",
        productId: "rp",
        familyProductId: "fam",
        version: 2,
        unitsPerPack: 12,
        status: "DRAFT",
        activeFor: null,
      });
      return original(fn);
    });
    const err = await service.createVersion("r1").catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_VERSION_CONFLICT" });
    expect(recipes.filter((r) => r.version === 2)).toHaveLength(1);
  });

  it("tenant isolation (test 14, unit): an unknown or foreign recipe id -> 404", async () => {
    const { service } = await build("on", seedRecipes("DRAFT"));
    await expect(service.activate("not-mine")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createVersion("not-mine")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update("not-mine", {} as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("recipeUniqueViolation (the P2002 belt, both error shapes)", () => {
  const known = (meta: Row) =>
    Object.assign(Object.create(Prisma.PrismaClientKnownRequestError.prototype), {
      code: "P2002",
      meta,
    });

  it("reads the native target and the driver-adapter constraint shapes", () => {
    expect(recipeUniqueViolation(known({ target: ["activeFor"] }))).toBe("activeFor");
    expect(recipeUniqueViolation(known({ target: "Recipe_activeFor_key" }))).toBe("activeFor");
    expect(
      recipeUniqueViolation(
        known({ driverAdapterError: { cause: { constraint: { fields: ["activeFor"] } } } }),
      ),
    ).toBe("activeFor");
    expect(recipeUniqueViolation(known({ target: ["productId", "version"] }))).toBe(
      "productVersion",
    );
    expect(
      recipeUniqueViolation(
        known({
          driverAdapterError: { cause: { constraint: { index: "Recipe_productId_version_key" } } },
        }),
      ),
    ).toBe("productVersion");
  });

  it("ignores another constraint and non-unique errors", () => {
    expect(recipeUniqueViolation(known({ target: ["tenantId", "barcode"] }))).toBeNull();
    expect(recipeUniqueViolation(new Error("boom"))).toBeNull();
  });
});
