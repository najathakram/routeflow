import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-584 B2 (a)/(c): while a recipe is DRAFT or ACTIVE, `ProductsService.update` refuses the edits
 * that break its invariants, from INSIDE its transaction, after its own row (and the family row
 * above it, house order) is locked:
 *   - re-parenting a component out of its family (I2)                    409 RECIPE_FAMILY_LOCKED
 *   - adopting the recipe product or a family that has a recipe          409 RECIPE_INVALID
 *   - a `unitsPerBox` change on the family or the recipe product (Q10)   409 RECIPE_FAMILY_LOCKED
 * RETIRED recipes never lock anything.
 */
type Recipe = {
  id: string;
  productId: string;
  familyProductId: string;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  components: string[];
};

const base = {
  id: "prod-1",
  name: "Cherry",
  sku: "CH-1",
  unit: "case",
  isActive: true,
  imageKeys: [] as string[],
  barcode: null,
  unitsPerBox: 12,
  parentProductId: "fam" as string | null,
  kind: "STANDARD",
  familyPriceOverride: false,
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  regItemType: null,
  regUomCase: null,
  regUomUnit: null,
  category: null,
  trackedSubcategory: null,
  variants: [],
};

const isOpen = (r: Recipe) => r.status === "DRAFT" || r.status === "ACTIVE";
const inOpenRoles = (r: Recipe, id: string) =>
  isOpen(r) && (r.productId === id || r.familyProductId === id || r.components.includes(id));

async function build(
  existing: Record<string, unknown>,
  recipes: Recipe[],
  mode: "on" | "off" = "off",
) {
  const prisma = createMockPrisma();
  const events: string[] = [];
  const recipeApi = (tag: "outer" | "tx") => ({
    findFirst: jest.fn(async ({ where }: any) => {
      events.push(`${tag}:recipe.findFirst`);
      if (where.status) return recipes.find((r) => inOpenRoles(r, where.OR[0].productId)) ?? null;
      return recipes.find((r) => r.productId === where.productId) ?? null;
    }),
    findMany: jest.fn(async ({ where }: any) => {
      events.push(`${tag}:recipe.findMany`);
      return recipes.filter((r) => inOpenRoles(r, where.OR[0].productId));
    }),
  });
  prisma.recipe.findFirst = recipeApi("outer").findFirst as any;
  prisma.recipe.findMany = recipeApi("outer").findMany as any;
  prisma.product.findUnique.mockResolvedValue(existing as any);
  prisma.product.findFirst.mockResolvedValue(null);
  prisma.product.update.mockResolvedValue({ ...existing, barcode: null, imageKeys: [] } as any);
  const tx: any = {
    ...prisma,
    recipe: { ...prisma.recipe, ...recipeApi("tx") },
    product: {
      ...prisma.product,
      // The SA-603a active-name probe (`where.name`) finds no other holder; every other read is `existing`.
      findFirst: jest.fn(async (args: any) => (args?.where?.name ? null : existing)),
      // H2's read-only label plan walks the family chain: every family here is a standalone row.
      findMany: jest.fn(async (args: any) =>
        ((args?.where?.id?.in ?? []) as string[]).map((id) => ({ id, parentProductId: null })),
      ),
      update: jest.fn(async (args: any) => {
        events.push(`write:product:${args.where.id}`);
        return prisma.product.update(args);
      }),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const kind = /FOR UPDATE/i.test(strings.join("?")) ? "update" : "raw";
      events.push(`lock:${kind}:${String(values[0])}`);
      return [];
    }),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  tx.productCategoryLabel = { ...prisma.productCategoryLabel, findMany: jest.fn(async () => []) };
  prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(tx));
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ProductsService,
      { provide: PrismaService, useValue: prisma },
      { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
      { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
      { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
      entitlementAuthorityFromEntitlements,
      // #2185: the reorder gate's deny body reads admin overrides.
      { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
      { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      {
        provide: FeatureConfigService,
        useValue: { getEffectiveMode: jest.fn().mockResolvedValue(mode) },
      },
    ],
  }).compile();
  return { service: mod.get(ProductsService), prisma, events, tx };
}

const recipeOf = (over: Partial<Recipe> = {}): Recipe => ({
  id: "r1",
  productId: "rp",
  familyProductId: "fam",
  status: "DRAFT",
  components: ["prod-1", "other"],
  ...over,
});
const bodyOf = (e: any) => e.getResponse();

describe("re-parenting a recipe component (I2)", () => {
  it.each(["DRAFT", "ACTIVE"] as const)(
    "moving a component out of its family (to none) while the recipe is %s -> 409 RECIPE_FAMILY_LOCKED",
    async (status) => {
      const { service, prisma } = await build(base, [recipeOf({ status })]);
      const err = await service
        .update("prod-1", { parentProductId: null } as any, { packPrecondition: "internal" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
      expect(prisma.product.update).not.toHaveBeenCalled();
    },
  );

  it("moving a component to ANOTHER family is refused too", async () => {
    const { service, prisma } = await build(base, [recipeOf()]);
    const err = await service
      .update("prod-1", { parentProductId: "fam2" } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("a component that only sits in a RETIRED recipe may be re-parented", async () => {
    const { service, prisma } = await build(base, [recipeOf({ status: "RETIRED" })]);
    await expect(
      service.update("prod-1", { parentProductId: null } as any, { packPrecondition: "internal" }),
    ).resolves.toBeDefined();
    expect(prisma.product.update).toHaveBeenCalled();
  });

  it("a re-parent that names the CURRENT parent is an echo, not a change", async () => {
    const { service, events } = await build(base, [recipeOf()]);
    await service.update("prod-1", { parentProductId: "fam" } as any, {
      packPrecondition: "internal",
    });
    expect(events.filter((e) => e.includes("recipe."))).toEqual([]);
  });
});

describe("adopting a recipe product or a family with a recipe into a family (Q1)", () => {
  const recipeProduct = { ...base, id: "rp", parentProductId: null, kind: "RECIPE" };
  const family = { ...base, id: "fam", parentProductId: null };

  it("the recipe product cannot be given a parent -> 409 RECIPE_INVALID RECIPE_PRODUCT_HAS_PARENT", async () => {
    const { service, prisma } = await build(recipeProduct, [recipeOf({ status: "RETIRED" })]);
    const err = await service
      .update("rp", { parentProductId: "fam-x" } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "RECIPE_PRODUCT_HAS_PARENT",
    });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("SA-587: the recipe-product decision is made from a POST-lock read (the pre-lock read said none, a recipe.create committed while we waited) -> 409", async () => {
    const recipeProduct = { ...base, id: "rp", parentProductId: null, kind: "STANDARD" };
    const recipes: Recipe[] = [];
    const { service, prisma, tx, events } = await build(recipeProduct, recipes);
    const lock = tx.$queryRaw;
    tx.$queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const out = await lock(strings, ...values);
      // the concurrent recipes.create(rp) commits once its row lock is released to us
      if (values[0] === "rp" && recipes.length === 0) recipes.push(recipeOf({ status: "ACTIVE" }));
      return out;
    });
    const err = await service
      .update("rp", { parentProductId: "fam-x" } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "RECIPE_PRODUCT_HAS_PARENT",
    });
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(events.lastIndexOf("tx:recipe.findFirst")).toBeGreaterThan(
      events.indexOf("lock:update:rp"),
    );
  });

  it("a family with an open recipe cannot become a variant -> 409 RECIPE_INVALID FAMILY_IS_VARIANT", async () => {
    const { service, prisma } = await build(family, [recipeOf({ status: "ACTIVE" })]);
    const err = await service
      .update("fam", { parentProductId: "fam-x" } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "FAMILY_IS_VARIANT" });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("a family whose recipes are all RETIRED may be adopted", async () => {
    const { service } = await build(family, [recipeOf({ status: "RETIRED" })]);
    await expect(
      service.update("fam", { parentProductId: "fam-x" } as any, { packPrecondition: "internal" }),
    ).resolves.toBeDefined();
  });
});

describe("unitsPerBox on the family and the recipe product (Q10)", () => {
  const family = { ...base, id: "fam", parentProductId: null };
  const recipeProduct = { ...base, id: "rp", parentProductId: null, kind: "RECIPE" };

  it("a family box-size change with an open recipe -> 409 RECIPE_FAMILY_LOCKED", async () => {
    const { service, prisma } = await build(family, [recipeOf()]);
    const err = await service
      .update("fam", { unitsPerBox: 24 } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("a recipe product box-size change with an open recipe -> 409 RECIPE_FAMILY_LOCKED", async () => {
    const { service } = await build(recipeProduct, [recipeOf({ status: "ACTIVE" })]);
    const err = await service
      .update("rp", { unitsPerBox: 6 } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
  });

  it("a COMPONENT's own box size is not part of the recipe's shape: allowed", async () => {
    const { service, prisma } = await build(base, [recipeOf()]);
    await expect(
      service.update("prod-1", { unitsPerBox: 6 } as any, { packPrecondition: "internal" }),
    ).resolves.toBeDefined();
    expect(prisma.product.update).toHaveBeenCalled();
  });

  it("with only RETIRED recipes the family box size may change", async () => {
    const { service } = await build(family, [recipeOf({ status: "RETIRED" })]);
    await expect(
      service.update("fam", { unitsPerBox: 24 } as any, { packPrecondition: "internal" }),
    ).resolves.toBeDefined();
  });

  it("an echo of the current box size never consults the recipes", async () => {
    const { service, events } = await build(family, [recipeOf()]);
    await service.update("fam", { unitsPerBox: 12 } as any, { packPrecondition: "internal" });
    expect(events.filter((e) => e.includes("recipe."))).toEqual([]);
  });
});

describe("house lock order and in-tx checks (SA-584 B2 c)", () => {
  it("a component re-parent locks the family row, then its own row, THEN asks the recipes — through tx", async () => {
    const { service, events } = await build(base, [recipeOf()]);
    await service
      .update("prod-1", { parentProductId: null } as any, { packPrecondition: "internal" })
      .catch(() => undefined);
    const own = events.indexOf("lock:update:prod-1");
    expect(events.indexOf("lock:update:fam")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("lock:update:fam")).toBeLessThan(own);
    const firstAsk = events.findIndex((e) => e.includes("recipe."));
    expect(firstAsk).toBeGreaterThan(own);
    expect(events[firstAsk].startsWith("tx:")).toBe(true);
    expect(events.filter((e) => e.startsWith("outer:recipe."))).toEqual([]);
  });

  it("a recipe product's edit locks ITS FAMILY (from the recipe) before its own row", async () => {
    const recipeProduct = { ...base, id: "rp", parentProductId: null, kind: "RECIPE" };
    const { service, events } = await build(recipeProduct, [recipeOf({ status: "ACTIVE" })]);
    await service
      .update("rp", { unitsPerBox: 6 } as any, { packPrecondition: "internal" })
      .catch(() => undefined);
    expect(events.indexOf("lock:update:fam")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("lock:update:fam")).toBeLessThan(events.indexOf("lock:update:rp"));
  });

  it("the category lock (I6) also runs in the tx after the own-row lock", async () => {
    const { service, events } = await build(base, [recipeOf()]);
    const err = await service
      .update("prod-1", { trackedCategoryId: null } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_CATEGORY_LOCKED" });
    expect(events.indexOf("lock:update:prod-1")).toBeGreaterThanOrEqual(0);
    const firstAsk = events.findIndex((e) => e.includes("recipe."));
    expect(firstAsk).toBeGreaterThan(events.indexOf("lock:update:prod-1"));
    expect(events.filter((e) => e.startsWith("outer:recipe."))).toEqual([]);
  });

  it("an unrelated edit takes no extra lock and asks nothing", async () => {
    const { service, events } = await build(base, [recipeOf()]);
    await service.update("prod-1", { description: "x" } as any, { packPrecondition: "internal" });
    expect(events.filter((e) => e.startsWith("lock:") || e.includes("recipe."))).toEqual([]);
  });

  it("a parent that changed between the read and the lock -> 409 (retry), nothing written", async () => {
    const { service, prisma } = await build(base, [recipeOf({ status: "RETIRED" })]);
    const original = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (fn: any) =>
      original((tx: any) => {
        tx.product.findFirst.mockResolvedValue({ ...base, parentProductId: "moved" });
        return fn(tx);
      }),
    );
    const err = await service
      .update("prod-1", { parentProductId: null } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});

describe("family-price.ts paths behind the guard (mode on, lead fold item 4)", () => {
  const priced = {
    pricePerUnit: "10.00",
    priceTier2: "10.00",
    priceTier3: "10.00",
    priceTier4: "10.00",
    priceTier5: "10.00",
  };

  it("adopting a RECIPE product into a family is refused BEFORE the adoption branch rewrites its price or audits", async () => {
    const recipeProduct = { ...base, ...priced, id: "rp", parentProductId: null, kind: "RECIPE" };
    const { service, prisma, tx } = await build(
      recipeProduct,
      [recipeOf({ status: "ACTIVE" })],
      "on",
    );
    const err = await service
      .update("rp", { parentProductId: "fam-x" } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({
      code: "RECIPE_INVALID",
      reason: "RECIPE_PRODUCT_HAS_PARENT",
    });
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("adopting a family that has a recipe is refused before the adoption branch too", async () => {
    const family = { ...base, ...priced, id: "fam", parentProductId: null };
    const { service, prisma, tx } = await build(family, [recipeOf({ status: "DRAFT" })], "on");
    const err = await service
      .update("fam", { parentProductId: "fam-x" } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_INVALID", reason: "FAMILY_IS_VARIANT" });
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("a component re-parent is refused by the guard before the family price branch runs", async () => {
    const component = { ...base, ...priced };
    const { service, tx } = await build(component, [recipeOf()], "on");
    const err = await service
      .update("prod-1", { parentProductId: "fam2" } as any, { packPrecondition: "internal" })
      .catch((e) => e);
    expect(bodyOf(err)).toMatchObject({ code: "RECIPE_FAMILY_LOCKED" });
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("a price edit of a recipe product takes the family lock BEFORE its own write (family -> recipe product)", async () => {
    const recipeProduct = { ...base, ...priced, id: "rp", parentProductId: null, kind: "RECIPE" };
    const { service, events } = await build(recipeProduct, [recipeOf({ status: "ACTIVE" })], "on");
    await service.update("rp", { pricePerUnit: "10.00" } as any, { packPrecondition: "internal" });
    const family = events.indexOf("lock:update:fam");
    expect(family).toBeGreaterThanOrEqual(0);
    expect(family).toBeLessThan(events.indexOf("write:product:rp"));
  });
});
