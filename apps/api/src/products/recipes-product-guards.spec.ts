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
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * #2717 M2 test 4 (I6) and test 13's unit half: ProductsService honours the recipe tables.
 *  - a product that sits in a non-RETIRED recipe (as recipe product, family or component) cannot
 *    change its tracked category or subcategory: 409 RECIPE_CATEGORY_LOCKED;
 *  - clearAll/bulkDelete treat a product referenced by a recipe as referenced (soft delete), so the
 *    RESTRICT foreign keys never raise P2003.
 */
describe("ProductsService recipe guards", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const existing = {
    id: "prod-1",
    name: "Cherry",
    sku: "CH-1",
    unit: "case",
    isActive: true,
    imageKeys: [] as string[],
    barcode: null,
    unitsPerBox: 12,
    parentProductId: "fam",
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

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.product.findUnique.mockResolvedValue(existing as any);
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.update.mockResolvedValue({ ...existing, barcode: null, imageKeys: [] } as any);
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: EntitlementsService,
          useValue: {
            hasFlag: jest.fn(async (_t: string, k: string) => k !== "flag.units_prices_v2"),
          },
        },
        entitlementAuthorityFromEntitlements,
        // #2185: the reorder gate's deny body reads admin overrides.
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
  });

  /** The recipe.findFirst answer for whichever recipe states the lock query asks about. */
  const recipeInState = (state: "DRAFT" | "ACTIVE" | "RETIRED") =>
    prisma.recipe.findFirst.mockImplementation(async ({ where }: any) =>
      (where.status.in as string[]).includes(state) ? { id: "r1" } : null,
    );

  it("4: a category change on a product in a DRAFT or ACTIVE recipe -> 409 RECIPE_CATEGORY_LOCKED", async () => {
    for (const state of ["DRAFT", "ACTIVE"] as const) {
      recipeInState(state);
      const err = await service
        .update("prod-1", { trackedCategoryId: null } as any, {
          packPrecondition: "internal",
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "RECIPE_CATEGORY_LOCKED" });
    }
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("4: the lock asks about the product as recipe product, family and component, never RETIRED", async () => {
    recipeInState("RETIRED");
    await service.update("prod-1", { trackedCategoryId: null } as any, {
      packPrecondition: "internal",
    });
    const where = prisma.recipe.findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["DRAFT", "ACTIVE"] });
    expect(JSON.stringify(where.OR)).toContain("productId");
    expect(JSON.stringify(where.OR)).toContain("familyProductId");
    expect(JSON.stringify(where.OR)).toContain("componentProductId");
  });

  it("4: a product only in RETIRED recipes may change category (200)", async () => {
    recipeInState("RETIRED");
    await expect(
      service.update("prod-1", { trackedCategoryId: null } as any, {
        packPrecondition: "internal",
      }),
    ).resolves.toBeDefined();
    expect(prisma.product.update).toHaveBeenCalled();
  });

  it("4: an edit that leaves the category alone never consults the recipes", async () => {
    await service.update("prod-1", { description: "x" } as any, {
      packPrecondition: "internal",
    });
    expect(prisma.recipe.findFirst).not.toHaveBeenCalled();
  });

  describe("clearAll with recipe references (test 13, unit half)", () => {
    beforeEach(() => {
      prisma.product.findMany.mockImplementation(async ({ where }: any) =>
        where?.id?.in ? [{ id: "prod-1", name: "Cherry" }] : [{ id: "prod-1" }],
      );
    });

    it.each([
      [
        "a recipe product",
        () =>
          prisma.recipe.groupBy.mockImplementation(async ({ by }: any) =>
            by[0] === "productId" ? [{ productId: "prod-1" }] : [],
          ),
      ],
      [
        "a recipe family",
        () =>
          prisma.recipe.groupBy.mockImplementation(async ({ by }: any) =>
            by[0] === "familyProductId" ? [{ familyProductId: "prod-1" }] : [],
          ),
      ],
      [
        "a recipe component",
        () => prisma.recipeComponent.groupBy.mockResolvedValue([{ componentProductId: "prod-1" }]),
      ],
    ])("%s is soft-deleted, never hard-deleted", async (_label, arrange) => {
      arrange();
      const result = await service.clearAll();
      expect(result).toMatchObject({ deleted: 0, softDeleted: 1 });
      expect(prisma.product.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("a reference-free product is still hard-deleted", async () => {
      prisma.$transaction.mockResolvedValue([] as any);
      const result = await service.clearAll();
      expect(result).toMatchObject({ deleted: 1, softDeleted: 0 });
    });
  });
});
