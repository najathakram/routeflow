import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, BadRequestException, ForbiddenException } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { createMockPrisma } from "../testing/prisma-mock";

const MOCK_PRODUCT = {
  id: "prod-1",
  name: "Cherry Tomatoes",
  sku: "TOM-001",
  unit: "punnet",
  pricePerUnit: 4.99,
  category: "Produce",
  description: "Fresh cherry tomatoes",
  isActive: true,
  imageKeys: [] as string[],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("ProductsService", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let addonService: { hasAddon: jest.Mock };
  let systemConfig: { get: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();

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
        {
          provide: AddonService,
          useValue: { hasAddon: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null) },
        },
        // MSRP gate collaborators — flag.msrp defaults OFF; the pre-MSRP tests
        // never send an msrp key, so assertMsrpAllowed is never even called.
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    addonService = module.get(AddonService);
    systemConfig = module.get(SystemConfigService);
  });

  // ─── findAll ──────────────────────────────────────────────────────────────

  describe("findAll", () => {
    it("should return paginated products", async () => {
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    });

    it("should apply search filter", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ search: "tomato", page: 1, limit: 20 });

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: expect.any(Object) }),
              expect.objectContaining({ unitSku: expect.any(Object) }),
            ]),
          }),
        }),
      );
    });

    it("should filter by category", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ category: "Produce", page: 1, limit: 20 });

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: "Produce" }),
        }),
      );
    });

    it("out-of-stock alone uses a top-level OR of the stock predicates", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ stockStatus: "OUT_OF_STOCK" } as any);

      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([{ isActive: false }, { currentStock: { lte: 0 } }]);
      expect(where.AND).toBeUndefined();
    });

    it("AND-s search with out-of-stock instead of collapsing them into one OR", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ search: "tomato", stockStatus: "OUT_OF_STOCK" } as any);

      const where = prisma.product.findMany.mock.calls[0][0].where;
      // The search disjunction must NOT be flattened into the stock disjunction —
      // otherwise every out-of-stock product matches regardless of the search text.
      expect(where.OR).toBeUndefined();
      expect(where.AND).toEqual([
        { OR: expect.arrayContaining([expect.objectContaining({ name: expect.any(Object) })]) },
        { OR: [{ isActive: false }, { currentStock: { lte: 0 } }] },
      ]);
      // count must use the identical where so pagination stays consistent
      expect(prisma.product.count.mock.calls[0][0].where).toBe(where);
    });

    it('filters by a section id when "section" is a uuid', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const sectionId = "11111111-1111-1111-1111-111111111111";
      await service.findAll({ section: sectionId } as any);

      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.trackedCategoryId).toBe(sectionId);
      expect(prisma.product.count.mock.calls[0][0].where).toBe(where);
    });

    it('filters to any regulated section when "section" is "any"', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ section: "any" } as any);

      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.trackedCategoryId).toEqual({ not: null });
    });

    it('filters to non-regulated products when "section" is "none"', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ section: "none" } as any);

      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.trackedCategoryId).toBeNull();
    });

    it("keeps BOTH the section filter and the internal buyer-catalog exclusion — neither overwrites the other", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const sectionId = "22222222-2222-2222-2222-222222222222";
      await service.findAll({ section: sectionId } as any, {
        excludeTrackedCategoryIds: ["excluded-1"],
      });

      const where = prisma.product.findMany.mock.calls[0][0].where;
      // The exclusion rides in AND as (NULL OR notIn) so untracked products survive…
      expect(where.AND).toEqual([
        { OR: [{ trackedCategoryId: null }, { trackedCategoryId: { notIn: ["excluded-1"] } }] },
      ]);
      // …leaving the section filter its own top-level slot.
      expect(where.trackedCategoryId).toBe(sectionId);
      expect(prisma.product.count.mock.calls[0][0].where).toBe(where);
    });
  });

  // ─── listCategories ───────────────────────────────────────────────────────

  describe("listCategories", () => {
    it("returns distinct trimmed categories, deduped case-insensitively, sorted", async () => {
      prisma.product.findMany.mockResolvedValue([
        { category: "Produce" },
        { category: "bakery" },
        { category: "Bakery" }, // case-dupe of "bakery" — first casing wins
        { category: "  Drinks  " }, // trimmed
        { category: "   " }, // whitespace-only → dropped
        { category: null }, // defensive; excluded by the where anyway
      ]);

      await expect(service.listCategories()).resolves.toEqual(["bakery", "Drinks", "Produce"]);
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { category: { not: null } },
          select: { category: true },
          distinct: ["category"],
        }),
      );
    });

    it("returns an empty array for a tenant with no categorized products", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      await expect(service.listCategories()).resolves.toEqual([]);
    });
  });

  // ─── findOne ──────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should return a product by id", async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      const result = await service.findOne("prod-1");
      expect(result).toMatchObject(MOCK_PRODUCT);
    });

    it("should throw NotFoundException when product does not exist", async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.findOne("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  // ─── findByBarcode ────────────────────────────────────────────────────────

  describe("findByBarcode", () => {
    it("resolves a case barcode hit, querying the candidate set", async () => {
      prisma.product.findMany.mockResolvedValue([{ ...MOCK_PRODUCT, barcode: "BC-1" }]);

      const result = await service.findByBarcode("BC-1");

      expect(result).toMatchObject({ barcode: "BC-1" });
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { barcode: { in: expect.arrayContaining(["BC-1"]) } },
              { sku: { in: expect.arrayContaining(["BC-1"]) } },
              { unitSku: { in: expect.arrayContaining(["BC-1"]) } },
            ],
          },
        }),
      );
    });

    it("matches a UPC-A scan against an EAN-13 stored code (the iOS decoder gap)", async () => {
      prisma.product.findMany.mockResolvedValue([{ ...MOCK_PRODUCT, barcode: "0012345678905" }]);

      const result = await service.findByBarcode("012345678905");

      expect(result).toMatchObject({ barcode: "0012345678905" });
      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.OR[0].barcode.in).toEqual(
        expect.arrayContaining(["012345678905", "0012345678905"]),
      );
    });

    it("falls back to a case-insensitive query only after the exact tier misses", async () => {
      prisma.product.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ ...MOCK_PRODUCT, sku: "tom-001" }]);

      const result = await service.findByBarcode("TOM-001");

      expect(result).toMatchObject({ sku: "tom-001" });
      expect(prisma.product.findMany).toHaveBeenCalledTimes(2);
      const secondWhere = prisma.product.findMany.mock.calls[1][0].where;
      expect(secondWhere.OR[0]).toEqual({
        barcode: { equals: "TOM-001", mode: "insensitive" },
      });
    });

    it("does not run the case-insensitive tier when the exact tier hits", async () => {
      prisma.product.findMany.mockResolvedValue([{ ...MOCK_PRODUCT, barcode: "BC-1" }]);

      await service.findByBarcode("BC-1");

      expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    });

    it("resolves a unitSku-only hit (no matching barcode/sku)", async () => {
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, barcode: null, sku: "TOM-001", unitSku: "UNIT-1" },
      ]);

      const result = await service.findByBarcode("UNIT-1");

      expect(result).toMatchObject({ unitSku: "UNIT-1" });
    });

    it("prioritizes barcode over sku/unitSku when findMany returns rows out of order", async () => {
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-unit", barcode: null, sku: null, unitSku: "SHARED" },
        { ...MOCK_PRODUCT, id: "prod-sku", barcode: null, sku: "SHARED", unitSku: null },
        { ...MOCK_PRODUCT, id: "prod-barcode", barcode: "SHARED", sku: null, unitSku: null },
      ]);

      const result = await service.findByBarcode("SHARED");

      expect(result.id).toBe("prod-barcode");
    });

    it("prioritizes sku over unitSku when no barcode matches", async () => {
      prisma.product.findMany.mockResolvedValue([
        { ...MOCK_PRODUCT, id: "prod-unit", barcode: null, sku: null, unitSku: "SHARED" },
        { ...MOCK_PRODUCT, id: "prod-sku", barcode: null, sku: "SHARED", unitSku: null },
      ]);

      const result = await service.findByBarcode("SHARED");

      expect(result.id).toBe("prod-sku");
    });

    it("throws NotFoundException when both tiers come back empty", async () => {
      prisma.product.findMany.mockResolvedValue([]);

      await expect(service.findByBarcode("NOPE")).rejects.toThrow(NotFoundException);
      expect(prisma.product.findMany).toHaveBeenCalledTimes(2);
    });

    it("throws without querying at all for a blank code", async () => {
      await expect(service.findByBarcode("   ")).rejects.toThrow(NotFoundException);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── create ───────────────────────────────────────────────────────────────

  describe("create", () => {
    it("should create a product with explicit field mapping", async () => {
      prisma.product.findFirst.mockResolvedValue(null); // SKU check — service uses findFirst
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      const result = await service.create({
        name: "Cherry Tomatoes",
        sku: "TOM-001",
        unit: "punnet",
        pricePerUnit: 4.99,
        category: "Produce",
        description: "Fresh cherry tomatoes",
      } as any);

      expect(result).toEqual(MOCK_PRODUCT);
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "Cherry Tomatoes",
            sku: "TOM-001",
            pricePerUnit: 4.99,
          }),
        }),
      );
    });

    it("should throw BadRequestException when SKU is duplicate", async () => {
      prisma.product.findFirst
        .mockResolvedValueOnce(null) // name check — no conflict
        .mockResolvedValueOnce(MOCK_PRODUCT); // SKU check — conflict

      await expect(
        service.create({ name: "Test", sku: "TOM-001", unit: "kg", pricePerUnit: 1 } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when unitSku collides with another product's sku/barcode/unitSku", async () => {
      prisma.product.findFirst
        .mockResolvedValueOnce(null) // name check — no conflict
        .mockResolvedValueOnce(null) // sku check — no conflict
        .mockResolvedValueOnce({ id: "prod-2" }); // unitSku collision check — conflict

      await expect(
        service.create({
          name: "Test",
          sku: "TOM-001",
          unit: "kg",
          pricePerUnit: 1,
          unitSku: "UNIT-1",
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("should allow creation without SKU", async () => {
      prisma.product.create.mockResolvedValue({ ...MOCK_PRODUCT, sku: null });

      const result = await service.create({
        name: "Test",
        unit: "kg",
        pricePerUnit: 1,
      } as any);

      expect(result).toBeDefined();
      // Should not check for duplicate SKU when sku is undefined
      expect(prisma.product.findUnique).not.toHaveBeenCalled();
    });

    // ── Tenant-default costing method (pos-cost-roles-spec §1) ──
    it("defaults a new product to the tenant costing method (WEIGHTED_AVERAGE → AVCO)", async () => {
      systemConfig.get.mockResolvedValue("WEIGHTED_AVERAGE");
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({ name: "T1", sku: "T-1", unit: "kg", pricePerUnit: 1 } as any);

      expect(systemConfig.get).toHaveBeenCalledWith("costing.method");
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ costingMethod: "AVCO" }) }),
      );
    });

    it("uses LAST_COST when the tenant costing method is LAST_COST", async () => {
      systemConfig.get.mockResolvedValue("LAST_COST");
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({ name: "T2", sku: "T-2", unit: "kg", pricePerUnit: 1 } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ costingMethod: "LAST_COST" }) }),
      );
    });

    it("keeps an explicit costing method over the tenant default", async () => {
      systemConfig.get.mockResolvedValue("WEIGHTED_AVERAGE");
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "T3",
        sku: "T-3",
        unit: "kg",
        pricePerUnit: 1,
        costingMethod: "FIFO",
      } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ costingMethod: "FIFO" }) }),
      );
    });

    it("leaves costingMethod undefined (schema default) when the tenant set none", async () => {
      systemConfig.get.mockResolvedValue(null);
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({ name: "T4", sku: "T-4", unit: "kg", pricePerUnit: 1 } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ costingMethod: undefined }) }),
      );
    });
  });

  // ─── create — variant inheritance ────────────────────────────────────────

  describe("create — variant inheritance", () => {
    // Numbers stand in for Prisma Decimals — the service only calls .toString().
    const MOCK_PARENT = {
      id: "parent-1",
      priceTier2: 24,
      priceTier3: 23,
      priceTier4: 22,
      priceTier5: 21,
      category: "Vapes",
      unitsPerBox: 10,
      costingMethod: "AVCO",
      standardCost: 12.5,
      isTobacco: false,
    };

    const VARIANT_DTO = {
      name: "Strawberry",
      variantName: "Strawberry",
      parentProductId: "parent-1",
      unit: "each",
      pricePerUnit: "30",
      sku: "STR-0001",
    };

    beforeEach(() => {
      // product.findFirst now serves BOTH the name/SKU/barcode conflict checks
      // (no where.id) AND the converted parent load (where.id === parentProductId)
      // — dispatch on the where clause so each read gets its own answer.
      prisma.product.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id === "parent-1" ? MOCK_PARENT : null),
      );
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);
    });

    it("inherits the PARENT's tiers (not dto.pricePerUnit) when tiers are omitted", async () => {
      await service.create({ ...VARIANT_DTO } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            priceTier2: "24",
            priceTier3: "23",
            priceTier4: "22",
            priceTier5: "21",
          }),
        }),
      );
    });

    it("keeps an explicit dto tier over the parent's", async () => {
      await service.create({ ...VARIANT_DTO, priceTier2: "9.99" } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ priceTier2: "9.99", priceTier3: "23" }),
        }),
      );
    });

    it("inherits category/unitsPerBox/standardCost/costingMethod when unset", async () => {
      await service.create({ ...VARIANT_DTO } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            category: "Vapes",
            unitsPerBox: 10,
            standardCost: "12.5",
            costingMethod: "AVCO",
          }),
        }),
      );
      // Variants bypass the tenant-default costing resolution entirely.
      expect(systemConfig.get).not.toHaveBeenCalled();
    });

    it("keeps explicit dto values over the parent's", async () => {
      await service.create({
        ...VARIANT_DTO,
        category: "Disposables",
        unitsPerBox: 5,
        standardCost: "9.9999",
        costingMethod: "FIFO",
      } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            category: "Disposables",
            unitsPerBox: 5,
            standardCost: "9.9999",
            costingMethod: "FIFO",
          }),
        }),
      );
    });

    it("inherits isTobacco from the parent WITHOUT re-checking the addon", async () => {
      prisma.product.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id === "parent-1" ? { ...MOCK_PARENT, isTobacco: true } : null),
      );
      addonService.hasAddon.mockResolvedValue(false); // would reject a DTO-flagged create

      await service.create({ ...VARIANT_DTO } as any);

      expect(addonService.hasAddon).not.toHaveBeenCalled();
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isTobacco: true }) }),
      );
    });

    it("leaves standalone creates unchanged (tiers default to pricePerUnit)", async () => {
      await service.create({ name: "Solo", unit: "kg", pricePerUnit: "5", sku: "SOL-1" } as any);

      // no parent load — findFirst is still called for the SKU check, but never
      // with the id-keyed where the parent lookup uses
      expect(prisma.product.findFirst).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: expect.anything() }) }),
      );
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            priceTier2: "5",
            priceTier3: "5",
            priceTier4: "5",
            priceTier5: "5",
            category: undefined,
            unitsPerBox: undefined,
            standardCost: undefined,
          }),
        }),
      );
    });
  });

  // ─── bulkAssignParent ─────────────────────────────────────────────────────

  describe("bulkAssignParent", () => {
    it("rejects when the parent does not exist", async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(
        service.bulkAssignParent({
          parentProductId: "missing",
          assignments: [{ id: "prod-a", variantName: "Strawberry" }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects when the parent is itself a variant", async () => {
      prisma.product.findFirst.mockResolvedValue({ id: "child", parentProductId: "root" });

      await expect(
        service.bulkAssignParent({
          parentProductId: "child",
          assignments: [{ id: "prod-a", variantName: "Strawberry" }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("isolates per-item failures — surfaces validation messages, masks raw errors (F8-003)", async () => {
      prisma.product.findFirst.mockResolvedValue({ id: "parent-1", parentProductId: null });
      const update = jest
        .spyOn(service, "update")
        .mockResolvedValueOnce({} as any)
        // Intentional app validation (HttpException) → the user-facing message is kept.
        .mockRejectedValueOnce(
          new BadRequestException('A variant named "Grape" already exists for this product'),
        )
        // A raw/unknown error (e.g. a Prisma constraint) → GENERIC reason, no disclosure.
        .mockRejectedValueOnce(
          new Error('Unique constraint failed on the fields: ("tenantId","sku")'),
        );

      const result = await service.bulkAssignParent({
        parentProductId: "parent-1",
        assignments: [
          { id: "prod-a", variantName: "Strawberry" },
          { id: "prod-b", variantName: "Grape" },
          { id: "prod-c", variantName: "Apple" },
        ],
      } as any);

      expect(result).toEqual({
        succeeded: ["prod-a"],
        failed: [
          { id: "prod-b", reason: 'A variant named "Grape" already exists for this product' },
          { id: "prod-c", reason: "Update failed" }, // raw Prisma text NOT disclosed
        ],
      });
      // Each row goes through the full update() path, variant name doubling as `name`.
      expect(update).toHaveBeenNthCalledWith(1, "prod-a", {
        parentProductId: "parent-1",
        variantName: "Strawberry",
        name: "Strawberry",
      });
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────

  describe("update", () => {
    it("should update a product", async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      prisma.product.findFirst.mockResolvedValue(null); // no SKU conflict
      prisma.product.update.mockResolvedValue({ ...MOCK_PRODUCT, name: "Updated" });

      const result = await service.update("prod-1", { name: "Updated" } as any);

      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "prod-1" } }),
      );
    });

    it("should throw NotFoundException when product does not exist", async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.update("nonexistent", {} as any)).rejects.toThrow(NotFoundException);
    });

    it("should throw BadRequestException on SKU conflict with another product", async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      prisma.product.findFirst.mockResolvedValue({ id: "prod-2", sku: "DUP-SKU" });

      await expect(service.update("prod-1", { sku: "DUP-SKU" } as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when unitSku collides with another product's sku/barcode/unitSku", async () => {
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      prisma.product.findFirst.mockResolvedValue({ id: "prod-2" });

      await expect(service.update("prod-1", { unitSku: "DUP-UNIT" } as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("syncs variantName with name when renaming a variant (name===variantName invariant)", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        parentProductId: "parent-1",
        variantName: "Strawberry",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { name: "Strawberry Banana" } as any);

      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "Strawberry Banana",
            variantName: "Strawberry Banana",
          }),
        }),
      );
    });

    it("does NOT set variantName when renaming a standalone product", async () => {
      prisma.product.findUnique.mockResolvedValue({ ...MOCK_PRODUCT, parentProductId: null });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { name: "Renamed" } as any);

      expect(prisma.product.update.mock.calls[0][0].data.variantName).toBeUndefined();
    });
  });

  // ─── isTobacco flag (tobacco_dealer addon) ──────────────────────────────────

  describe("isTobacco flag", () => {
    it("filters findAll by isTobacco", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll({ isTobacco: true } as any);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isTobacco: true }) }),
      );
    });

    it("rejects flagging a product as tobacco without the addon", async () => {
      addonService.hasAddon.mockResolvedValue(false);

      await expect(
        service.create({ name: "Marlboro Red", unit: "pack", isTobacco: true } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("allows flagging with the addon active", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      prisma.product.findFirst.mockResolvedValue(null);

      await service.create({
        name: "Marlboro Red",
        unit: "pack",
        pricePerUnit: "10.00",
        isTobacco: true,
      } as any);

      expect(addonService.hasAddon).toHaveBeenCalledWith("test-tenant", "tobacco_dealer");
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isTobacco: true }) }),
      );
    });

    it("always allows CLEARING the flag (addon revoked)", async () => {
      addonService.hasAddon.mockResolvedValue(false);
      prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT);
      prisma.product.findFirst.mockResolvedValue(null);

      await service.update("prod-1", { isTobacco: false } as any);

      expect(addonService.hasAddon).not.toHaveBeenCalled();
      expect(prisma.product.update).toHaveBeenCalled();
    });
  });

  // ─── isTobacco write-sync (2026-08-24 tobacco→Regulated consolidation) ──────
  // Category is the ONE axis; isTobacco is a derived mirror of membership in
  // the tenant's Tobacco type. See apps/api/src/common/tobacco-category.ts.

  describe("isTobacco write-sync (compliance-pack consolidation)", () => {
    it("PATCH {isTobacco:true} with no category assigns the product to the EXISTING Tobacco type, clearing the subcategory", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-other",
        trackedSubcategoryId: "sub-other",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue({ id: "tobacco-cat", name: "Tobacco" });
      prisma.trackedCategory.findUnique.mockResolvedValue({ name: "Tobacco" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { isTobacco: true } as any);

      expect(prisma.trackedCategory.findFirst).toHaveBeenCalledWith({
        where: { name: { equals: "Tobacco", mode: "insensitive" } },
        select: { id: true, name: true },
      });
      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.trackedCategoryId).toBe("tobacco-cat");
      expect(data.trackedSubcategoryId).toBeNull();
      expect(data.isTobacco).toBe(true);
    });

    it("PATCH {isTobacco:true} with NO Tobacco type yet creates one with the W1-seed values", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      prisma.product.findUnique.mockResolvedValue({ ...MOCK_PRODUCT, trackedCategoryId: null });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(null); // no existing Tobacco type
      prisma.trackedCategory.create.mockResolvedValue({ id: "new-tobacco-cat" });
      prisma.trackedCategory.findUnique.mockResolvedValue({ name: "Tobacco" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { isTobacco: true } as any);

      expect(prisma.trackedCategory.create).toHaveBeenCalledWith({
        data: {
          tenantId: "test-tenant",
          name: "Tobacco",
          taxType: "NONE",
          requiresLicense: false,
          reportTemplate: "CA_CDTFA",
          reportCadence: "MONTHLY",
          invoiceTreatment: "SEPARATE_INVOICE",
          active: true,
        },
        select: { id: true },
      });
      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.trackedCategoryId).toBe("new-tobacco-cat");
      expect(data.isTobacco).toBe(true);
    });

    it("PATCH {isTobacco:false} on a Tobacco-type member clears the category and the flag", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "tobacco-cat",
        trackedSubcategoryId: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue({ id: "tobacco-cat", name: "Tobacco" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { isTobacco: false } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.trackedCategoryId).toBeNull();
      expect(data.isTobacco).toBe(false);
    });

    it("PATCH {isTobacco:false} KEEPS the regulatory reporting trio", async () => {
      // "Unmark tobacco product" is one unconfirmed menu action that used to
      // write only the boolean. The filing resolves item type / UoM from the
      // product row LIVE, so wiping the trio here would silently restate
      // already-filed periods — and re-flagging never restores it.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        isTobacco: true,
        trackedCategoryId: "tobacco-cat",
        trackedSubcategoryId: null,
        regItemType: "20",
        regUomCase: "CS",
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue({ id: "tobacco-cat", name: "Tobacco" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { isTobacco: false } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.trackedCategoryId).toBeNull();
      expect(data.isTobacco).toBe(false);
      expect(data.regItemType).toBeUndefined();
      expect(data.regUomCase).toBeUndefined();
      expect(data.regUomUnit).toBeUndefined();
    });

    it("a quick-toggle the section validations reject does NOT seed a Tobacco type", async () => {
      // The seeded type is CA_CDTFA (no per-product config), so a product
      // carrying stranded reg codes can't move into it. The rejection must land
      // BEFORE the create, or the tenant is left with an orphan regulated
      // section it never had.
      addonService.hasAddon.mockResolvedValue(true);
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-other",
        trackedSubcategoryId: null,
        regItemType: "20",
        regUomCase: "CS",
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(null); // no Tobacco type yet

      await expect(service.update("prod-1", { isTobacco: true } as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("PATCH {isTobacco:false} on a product NOT in the Tobacco type leaves the category untouched", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-other",
        trackedSubcategoryId: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue({ id: "tobacco-cat", name: "Tobacco" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { isTobacco: false } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.trackedCategoryId).toBeUndefined();
      // Section didn't change, but isTobacco was explicitly sent — direct write.
      expect(data.isTobacco).toBe(false);
    });

    it("PATCH {trackedCategoryId:<nonTobacco>} on a flagged product writes isTobacco:false", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        isTobacco: true,
        trackedCategoryId: "tobacco-cat",
        trackedSubcategoryId: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findUnique.mockResolvedValue({ name: "Produce" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { trackedCategoryId: "sec-produce" } as any);

      expect(prisma.trackedCategory.findUnique).toHaveBeenCalledWith({
        where: { id: "sec-produce" },
        select: { name: true },
      });
      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.isTobacco).toBe(false);
    });

    it("PATCH {trackedCategoryId:<tobaccoId>} writes isTobacco:true even without dto.isTobacco", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-other",
        trackedSubcategoryId: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findUnique.mockResolvedValue({ name: "Tobacco" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { trackedCategoryId: "tobacco-cat" } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.isTobacco).toBe(true);
    });

    it("an unrelated PATCH (rename/price) performs NO trackedCategory lookup and leaves isTobacco out of the update data", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { pricePerUnit: "9.99" } as any);

      expect(prisma.trackedCategory.findUnique).not.toHaveBeenCalled();
      expect(prisma.trackedCategory.findFirst).not.toHaveBeenCalled();
      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.isTobacco).toBeUndefined();
    });

    it("create with {isTobacco:true} and no category links the product into the Tobacco type and flags it", async () => {
      addonService.hasAddon.mockResolvedValue(true);
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue({ id: "tobacco-cat", name: "Tobacco" });
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Marlboro Red",
        unit: "pack",
        pricePerUnit: "10.00",
        isTobacco: true,
      } as any);

      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ trackedCategoryId: "tobacco-cat", isTobacco: true }),
        }),
      );
    });
  });

  // ─── regulated section + subcategory (Phase 4) ──────────────────────────────

  describe("regulated section + subcategory", () => {
    it("tags a product with a valid section + subcategory", async () => {
      prisma.product.findFirst.mockResolvedValue(null); // name + sku checks
      prisma.trackedSubcategory.findFirst.mockResolvedValue({ trackedCategoryId: "sec-1" });
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Marlboro",
        sku: "MAR-1",
        unit: "pack",
        pricePerUnit: "10",
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
      } as any);

      expect(prisma.trackedSubcategory.findFirst).toHaveBeenCalledWith({
        where: { id: "sub-1" },
        select: { trackedCategoryId: true },
      });
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trackedCategoryId: "sec-1",
            trackedSubcategoryId: "sub-1",
          }),
        }),
      );
    });

    it("rejects a subcategory that belongs to a different section", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedSubcategory.findFirst.mockResolvedValue({ trackedCategoryId: "OTHER" });

      await expect(
        service.create({
          name: "X",
          sku: "X-1",
          unit: "pack",
          pricePerUnit: "1",
          trackedCategoryId: "sec-1",
          trackedSubcategoryId: "sub-1",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("rejects a subcategory with no section (short-circuits before any lookup)", async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(
        service.create({
          name: "X",
          sku: "X-2",
          unit: "pack",
          pricePerUnit: "1",
          trackedSubcategoryId: "sub-1",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.trackedSubcategory.findFirst).not.toHaveBeenCalled();
    });

    it("clears the subcategory when the section is cleared on update", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { trackedCategoryId: null } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.trackedCategoryId).toBeNull();
      expect(data.trackedSubcategoryId).toBeNull();
    });

    it("a variant inherits the parent's section + subcategory when the DTO omits them", async () => {
      // product.findFirst serves both the name/sku conflict checks (no where.id)
      // and the converted parent load (where.id === parentProductId).
      const PARENT = {
        priceTier2: 1,
        priceTier3: 1,
        priceTier4: 1,
        priceTier5: 1,
        category: "Vapes",
        unitsPerBox: 1,
        costingMethod: "AVCO",
        standardCost: 1,
        isTobacco: false,
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
      };
      prisma.product.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id === "parent-1" ? PARENT : null),
      );
      prisma.trackedSubcategory.findFirst.mockResolvedValue({ trackedCategoryId: "sec-1" });
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Strawberry",
        variantName: "Strawberry",
        parentProductId: "parent-1",
        unit: "each",
        pricePerUnit: "30",
      } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trackedCategoryId: "sec-1",
            trackedSubcategoryId: "sub-1",
          }),
        }),
      );
    });
  });

  // ─── regulatory reporting config (per-product item type / UoM, WP6) ────────
  // The vocabulary itself (item types → legal UoM codes, which templates carry
  // per-product config) lives in regulated/template-registry.ts; item type "1"
  // (Cigarettes) allows CP/CS/CC, item type "2" (Cigars) allows SB/SC/SD/SF —
  // see TX_COMPTROLLER in that file for the full list.

  describe("regulatory reporting config", () => {
    const TX_CATEGORY = { name: "Tobacco", reportTemplate: "TX_COMPTROLLER" };
    const GENERIC_CATEGORY = { name: "Produce", reportTemplate: "GENERIC" };

    it("saves a product with no regulatory config with no extra trackedCategory lookup", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Plain Widget",
        sku: "PW-2",
        unit: "each",
        pricePerUnit: "2",
      } as any);

      expect(prisma.trackedCategory.findFirst).not.toHaveBeenCalled();
    });

    it("persists valid TX Comptroller codes", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Marlboro Red",
        sku: "MAR-2",
        unit: "pack",
        pricePerUnit: "10",
        trackedCategoryId: "sec-tx",
        regItemType: "1",
        regUomCase: "CC",
        regUomUnit: "CP",
      } as any);

      expect(prisma.trackedCategory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "sec-tx" } }),
      );
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            regItemType: "1",
            regUomCase: "CC",
            regUomUnit: "CP",
          }),
        }),
      );
    });

    it("rejects regulatory config with no section (short-circuits before any lookup)", async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(
        service.create({
          name: "X",
          sku: "X-3",
          unit: "pack",
          pricePerUnit: "1",
          regItemType: "1",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.trackedCategory.findFirst).not.toHaveBeenCalled();
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("rejects an invalid item type", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);

      await expect(
        service.create({
          name: "X",
          sku: "X-4",
          unit: "pack",
          pricePerUnit: "1",
          trackedCategoryId: "sec-tx",
          regItemType: "99",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("rejects a UoM that is not valid for the chosen item type", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);

      await expect(
        service.create({
          name: "X",
          sku: "X-5",
          unit: "pack",
          pricePerUnit: "1",
          trackedCategoryId: "sec-tx",
          regItemType: "1", // Cigarettes
          regUomUnit: "WO", // Tobacco-only UoM
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("rejects a UoM that belongs to a DIFFERENT item type when the item type is set", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);

      await expect(
        service.create({
          name: "X",
          sku: "X-6",
          unit: "pack",
          pricePerUnit: "1",
          trackedCategoryId: "sec-tx",
          regItemType: "2", // Cigars
          regUomCase: "CC", // valid for Cigarettes ("1"), not Cigars
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("rejects regulatory config on a section whose template has no per-product config", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(GENERIC_CATEGORY);

      await expect(
        service.create({
          name: "X",
          sku: "X-7",
          unit: "pack",
          pricePerUnit: "1",
          trackedCategoryId: "sec-generic",
          regItemType: "1",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("a variant inherits the parent's regulatory trio when the DTO omits the section", async () => {
      const PARENT = {
        priceTier2: 1,
        priceTier3: 1,
        priceTier4: 1,
        priceTier5: 1,
        category: "Tobacco",
        unitsPerBox: 1,
        costingMethod: "AVCO",
        standardCost: 1,
        isTobacco: false,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: "CC",
        regUomUnit: "CP",
      };
      prisma.product.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id === "parent-tx" ? PARENT : null),
      );
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Menthol",
        variantName: "Menthol",
        parentProductId: "parent-tx",
        unit: "pack",
        pricePerUnit: "10",
      } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trackedCategoryId: "sec-tx",
            regItemType: "1",
            regUomCase: "CC",
            regUomUnit: "CP",
          }),
        }),
      );
    });

    it("an explicit DTO value on one field beats inheritance while the others still inherit", async () => {
      const PARENT = {
        priceTier2: 1,
        priceTier3: 1,
        priceTier4: 1,
        priceTier5: 1,
        category: "Tobacco",
        unitsPerBox: 1,
        costingMethod: "AVCO",
        standardCost: 1,
        isTobacco: false,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: "CC",
        regUomUnit: "CP",
      };
      prisma.product.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id === "parent-tx" ? PARENT : null),
      );
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Menthol",
        variantName: "Menthol",
        parentProductId: "parent-tx",
        unit: "pack",
        pricePerUnit: "10",
        regUomUnit: "CS", // explicit override of the parent's "CP"
      } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            regItemType: "1", // still inherited
            regUomCase: "CC", // still inherited
            regUomUnit: "CS", // explicit DTO value wins
          }),
        }),
      );
    });

    it("clears all three fields on update when the section is cleared, without re-validating them", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: "CC",
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { trackedCategoryId: null } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBeNull();
      expect(data.regUomCase).toBeNull();
      expect(data.regUomUnit).toBeNull();
      expect(prisma.trackedCategory.findFirst).not.toHaveBeenCalled();
    });

    // ─── fix round: unconditional section-clear + narrowed validation gate ────

    it("clears the trio even when the request ALSO sends an explicit reg code alongside the section clear", async () => {
      // Regression for the bug: the old auto-clear was gated on `existing.*`, so
      // when the product had NO prior reg config, sending trackedCategoryId: null
      // together with regItemType let the raw dto spread leak the code through.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: null,
        regUomCase: null,
        regUomUnit: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { trackedCategoryId: null, regItemType: "1" } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBeNull();
      expect(data.regUomCase).toBeNull();
      expect(data.regUomUnit).toBeNull();
    });

    it("still clears all three fields when a product that HAD reg config has its section cleared", async () => {
      // Keep-it-green guard: the unconditional clear must not lose this
      // previously-passing behavior for a product carrying real config.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: null, // TX Comptroller commonly leaves case UoM unset
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { trackedCategoryId: null } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBeNull();
      expect(data.regUomCase).toBeNull();
      expect(data.regUomUnit).toBeNull();
    });

    it("resolves an unrelated field edit without validating a stale trio left behind by a template change", async () => {
      // The section's template no longer carries per-product config (GENERIC),
      // but the product still has a leftover regItemType from before the switch.
      // A rename must not re-validate that stale config and 400.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-generic",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: null,
        regUomUnit: null,
      });
      prisma.product.findFirst.mockResolvedValue(null); // name-uniqueness check
      prisma.product.update.mockResolvedValue({ ...MOCK_PRODUCT, name: "Renamed" });

      await expect(service.update("prod-1", { name: "Renamed" } as any)).resolves.toBeDefined();

      expect(prisma.trackedCategory.findFirst).not.toHaveBeenCalled();
      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBeUndefined();
      expect(data.regUomCase).toBeUndefined();
      expect(data.regUomUnit).toBeUndefined();
    });

    it("still validates and persists explicit reg codes when the request touches the trio", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: null,
        regUomCase: null,
        regUomUnit: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { regItemType: "1", regUomUnit: "CP" } as any);

      expect(prisma.trackedCategory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "sec-tx" } }),
      );
      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBe("1");
      expect(data.regUomUnit).toBe("CP");
    });

    it("still 400s when a request touching only the UoM conflicts with the product's stored item type", async () => {
      // Proves the narrowed guard still validates against `existing.*` (not just
      // the dto) when the request DOES touch the trio.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: "1", // Cigarettes — stored, not re-sent in this PATCH
        regUomCase: "CC",
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);

      await expect(
        service.update("prod-1", { regUomUnit: "WO" } as any), // Tobacco-only UoM, invalid for item type "1"
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    // ─── stranded config must stay editable, and detached config must survive ──

    it("rejects a section move that would strand codes under a template with no per-product config", async () => {
      // A MOVE re-validates: the ledger keeps the OLD section but the report reads
      // the product's codes live, so carrying them into a template that can't
      // express them would silently restate already-filed periods. Rejected rather
      // than auto-cleared — both forms clear the trio client-side on a section
      // change, so an API-direct caller has to send the nulls itself.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: null,
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(GENERIC_CATEGORY);

      await expect(
        service.update("prod-1", { trackedCategoryId: "sec-generic" } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("accepts a section move that also clears the trio, the way both product forms send it", async () => {
      // The web/mobile forms reset all three codes when the section changes, so the
      // effective trio is empty and assertRegConfigValid short-circuits before any
      // lookup — but the write-sync mirror derivation (WP1) still looks up the
      // target category's name to keep isTobacco in sync with the move.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: null,
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findUnique.mockResolvedValue({ name: "Produce" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await expect(
        service.update("prod-1", {
          trackedCategoryId: "sec-generic",
          regItemType: null,
          regUomCase: null,
          regUomUnit: null,
        } as any),
      ).resolves.toBeDefined();

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBeNull();
      expect(data.regUomCase).toBeNull();
      expect(data.regUomUnit).toBeNull();
      // Mirror derivation (WP1): the move to a non-Tobacco section clears isTobacco.
      expect(data.isTobacco).toBe(false);
    });

    it("accepts a section move that echoes an unchanged trio still valid for the new template", async () => {
      // Same TX Comptroller vocabulary on both sides — the move re-validates and
      // passes, so a legitimate reshuffle between regulated sections still works.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: null,
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findFirst.mockResolvedValue(TX_CATEGORY);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await expect(
        service.update("prod-1", {
          trackedCategoryId: "sec-tx-2",
          regItemType: "1",
          regUomCase: null,
          regUomUnit: "CP",
        } as any),
      ).resolves.toBeDefined();

      expect(prisma.trackedCategory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "sec-tx-2" } }),
      );
      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBe("1");
      expect(data.regUomUnit).toBe("CP");
    });

    it("moves an unconfigured product between sections: assertRegConfigValid takes no extra lookup, the mirror derivation does", async () => {
      // Nothing to strand — the empty effective trio short-circuits the
      // reg-config validator, so THAT lookup is skipped. The write-sync mirror
      // derivation (WP1) still looks up the target category's name separately,
      // to keep isTobacco in sync with the move.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-tx",
        trackedSubcategoryId: null,
        regItemType: null,
        regUomCase: null,
        regUomUnit: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedCategory.findUnique.mockResolvedValue({ name: "Produce" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await expect(
        service.update("prod-1", { trackedCategoryId: "sec-generic" } as any),
      ).resolves.toBeDefined();

      expect(prisma.trackedCategory.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "sec-generic" } }),
      );
      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.isTobacco).toBe(false);
    });

    it("accepts the product form echoing an unchanged trio back for a stranded product", async () => {
      // The web detail form always sends all three keys, even when the section's
      // template makes it render none of them — an unchanged echo must never 400.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-generic",
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: null,
        regUomUnit: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await expect(
        service.update("prod-1", {
          pricePerUnit: "12",
          trackedCategoryId: "sec-generic",
          regItemType: "1",
          regUomCase: null,
          regUomUnit: null,
        } as any),
      ).resolves.toBeDefined();

      expect(prisma.trackedCategory.findFirst).not.toHaveBeenCalled();
    });

    it("rejects a reg code sent for a product that already has no section", async () => {
      // Nothing TRANSITIONS here (null → null), so the auto-clear does not fire and
      // there is no section whose template could validate the code — rejected rather
      // than silently coerced to null, exactly as create() rejects the same input.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
        regItemType: null,
        regUomCase: null,
        regUomUnit: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(
        service.update("prod-1", { trackedCategoryId: null, regItemType: "1" } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("keeps a detached product's regulatory config through an unrelated edit", async () => {
      // Products detached from their section keep backfilled codes so their
      // historic ledger rows still report an item type / UoM. A price edit (or the
      // form echoing the section back as null) must not erase them.
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: null,
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { pricePerUnit: "12" } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBeUndefined();
      expect(data.regUomCase).toBeUndefined();
      expect(data.regUomUnit).toBeUndefined();
    });

    it("keeps a detached product's regulatory config when the form echoes it with a null section", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
        regItemType: "1",
        regUomCase: null,
        regUomUnit: "CP",
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", {
        trackedCategoryId: null,
        regItemType: "1",
        regUomCase: null,
        regUomUnit: "CP",
      } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.regItemType).toBe("1");
      expect(data.regUomUnit).toBe("CP");
    });
  });

  // ─── category sync (one-category-axis rule) ─────────────────────────────────

  describe("category sync — create", () => {
    it("a structured subcategory's name WINS the category resolution over dto.category", async () => {
      prisma.product.findFirst.mockResolvedValue(null); // name/sku checks
      prisma.trackedSubcategory.findFirst
        .mockResolvedValueOnce({ trackedCategoryId: "sec-1" }) // assertSubcategoryInSection
        .mockResolvedValueOnce({ name: "Zyn" }); // sync fetch
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Zyn Pouches",
        sku: "ZYN-1",
        unit: "can",
        pricePerUnit: "5",
        category: "Tobacco", // must be ignored — the structured name wins
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
      } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ category: "Zyn" }),
        }),
      );
    });

    it("with a type but NO subcategory, dto.category is preserved untouched", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Loose Tobacco",
        sku: "LT-1",
        unit: "pack",
        pricePerUnit: "5",
        category: "Rolling",
        trackedCategoryId: "sec-1",
      } as any);

      expect(prisma.trackedSubcategory.findFirst).not.toHaveBeenCalled();
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ category: "Rolling" }),
        }),
      );
    });

    it("non-regulated creates are unaffected (no trackedSubcategory lookup at all)", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Plain Widget",
        sku: "PW-1",
        unit: "each",
        pricePerUnit: "2",
        category: "Hardware",
      } as any);

      expect(prisma.trackedSubcategory.findFirst).not.toHaveBeenCalled();
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ category: "Hardware" }) }),
      );
    });

    it("a variant inheriting the parent's regulated pair also gets the synced category name", async () => {
      const PARENT = {
        priceTier2: 1,
        priceTier3: 1,
        priceTier4: 1,
        priceTier5: 1,
        category: "Vapes",
        unitsPerBox: 1,
        costingMethod: "AVCO",
        standardCost: 1,
        isTobacco: false,
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
      };
      prisma.product.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.id === "parent-1" ? PARENT : null),
      );
      prisma.trackedSubcategory.findFirst
        .mockResolvedValueOnce({ trackedCategoryId: "sec-1" }) // assertSubcategoryInSection
        .mockResolvedValueOnce({ name: "Mint Vape" }); // sync fetch
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Mint",
        variantName: "Mint",
        parentProductId: "parent-1",
        unit: "each",
        pricePerUnit: "30",
      } as any);

      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ category: "Mint Vape" }),
        }),
      );
    });
  });

  describe("category sync — update", () => {
    it("setting a subcategory forces category to its name (dto.category ignored)", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: null,
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.trackedSubcategory.findFirst
        .mockResolvedValueOnce({ trackedCategoryId: "sec-1" }) // assertSubcategoryInSection
        .mockResolvedValueOnce({ name: "Juul Pods" }); // sync fetch
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", {
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
        category: "Vapes", // must be overridden
      } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.category).toBe("Juul Pods");
    });

    it("clearing the subcategory clears a category that was synced to its name", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        category: "Juul Pods", // synced to the (about-to-be-cleared) sub's name
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
        trackedSubcategory: { id: "sub-1", name: "Juul Pods", trackedCategoryId: "sec-1" },
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { trackedSubcategoryId: null } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.trackedSubcategoryId).toBeNull();
      expect(data.category).toBeNull();
    });

    it("clearing the subcategory leaves a DIVERGED (manually edited) category alone", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        category: "My Custom Label", // diverged from the synced name
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
        trackedSubcategory: { id: "sub-1", name: "Juul Pods", trackedCategoryId: "sec-1" },
      });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { trackedSubcategoryId: null } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.trackedSubcategoryId).toBeNull();
      expect(data.category).toBeUndefined();
    });

    it("a category-only edit on a structured product is forced back to the synced name", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...MOCK_PRODUCT,
        category: "Juul Pods",
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
        trackedSubcategory: { id: "sub-1", name: "Juul Pods", trackedCategoryId: "sec-1" },
      });
      prisma.product.findFirst.mockResolvedValue(null);
      // Re-validation of the unchanged pair on every update() call.
      prisma.trackedSubcategory.findFirst.mockResolvedValue({ trackedCategoryId: "sec-1" });
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { category: "Vapes" } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.category).toBe("Juul Pods");
    });

    it("a category-only edit on a NON-regulated product is untouched", async () => {
      prisma.product.findUnique.mockResolvedValue({ ...MOCK_PRODUCT, category: "Produce" });
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.update.mockResolvedValue(MOCK_PRODUCT);

      await service.update("prod-1", { category: "Groceries" } as any);

      const data = prisma.product.update.mock.calls[0][0].data;
      expect(data.category).toBe("Groceries");
      expect(prisma.trackedSubcategory.findFirst).not.toHaveBeenCalled();
    });
  });
});
