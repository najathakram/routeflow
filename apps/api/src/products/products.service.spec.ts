import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, BadRequestException, ForbiddenException } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
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

    it("AND-folds the section filter with the internal buyer-catalog exclusion instead of overwriting it", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const sectionId = "22222222-2222-2222-2222-222222222222";
      await service.findAll({ section: sectionId } as any, {
        excludeTrackedCategoryIds: ["excluded-1"],
      });

      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.trackedCategoryId).toEqual({ notIn: ["excluded-1"] });
      expect(where.AND).toEqual([{ trackedCategoryId: sectionId }]);
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
    it("resolves a case barcode hit", async () => {
      prisma.product.findMany.mockResolvedValue([{ ...MOCK_PRODUCT, barcode: "BC-1" }]);

      const result = await service.findByBarcode("BC-1");

      expect(result).toMatchObject({ barcode: "BC-1" });
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ barcode: "BC-1" }, { sku: "BC-1" }, { unitSku: "BC-1" }] },
        }),
      );
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

    it("throws NotFoundException when no product matches any of the three codes", async () => {
      prisma.product.findMany.mockResolvedValue([]);

      await expect(service.findByBarcode("NOPE")).rejects.toThrow(NotFoundException);
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
      prisma.product.findFirst.mockResolvedValue(null); // no name/SKU/barcode conflicts
      prisma.product.findUnique.mockResolvedValue(MOCK_PARENT); // parent load
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
      prisma.product.findUnique.mockResolvedValue({ ...MOCK_PARENT, isTobacco: true });
      addonService.hasAddon.mockResolvedValue(false); // would reject a DTO-flagged create

      await service.create({ ...VARIANT_DTO } as any);

      expect(addonService.hasAddon).not.toHaveBeenCalled();
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isTobacco: true }) }),
      );
    });

    it("leaves standalone creates unchanged (tiers default to pricePerUnit)", async () => {
      await service.create({ name: "Solo", unit: "kg", pricePerUnit: "5", sku: "SOL-1" } as any);

      expect(prisma.product.findUnique).not.toHaveBeenCalled(); // no parent load
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
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.bulkAssignParent({
          parentProductId: "missing",
          assignments: [{ id: "prod-a", variantName: "Strawberry" }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects when the parent is itself a variant", async () => {
      prisma.product.findUnique.mockResolvedValue({ id: "child", parentProductId: "root" });

      await expect(
        service.bulkAssignParent({
          parentProductId: "child",
          assignments: [{ id: "prod-a", variantName: "Strawberry" }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("isolates per-item failures — surfaces validation messages, masks raw errors (F8-003)", async () => {
      prisma.product.findUnique.mockResolvedValue({ id: "parent-1", parentProductId: null });
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

  // ─── regulated section + subcategory (Phase 4) ──────────────────────────────

  describe("regulated section + subcategory", () => {
    it("tags a product with a valid section + subcategory", async () => {
      prisma.product.findFirst.mockResolvedValue(null); // name + sku checks
      prisma.trackedSubcategory.findUnique.mockResolvedValue({ trackedCategoryId: "sec-1" });
      prisma.product.create.mockResolvedValue(MOCK_PRODUCT);

      await service.create({
        name: "Marlboro",
        sku: "MAR-1",
        unit: "pack",
        pricePerUnit: "10",
        trackedCategoryId: "sec-1",
        trackedSubcategoryId: "sub-1",
      } as any);

      expect(prisma.trackedSubcategory.findUnique).toHaveBeenCalledWith({
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
      prisma.trackedSubcategory.findUnique.mockResolvedValue({ trackedCategoryId: "OTHER" });

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
      expect(prisma.trackedSubcategory.findUnique).not.toHaveBeenCalled();
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
      prisma.product.findFirst.mockResolvedValue(null); // name / sku
      prisma.product.findUnique.mockResolvedValue({
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
      });
      prisma.trackedSubcategory.findUnique.mockResolvedValue({ trackedCategoryId: "sec-1" });
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

  // ─── category sync (one-category-axis rule) ─────────────────────────────────

  describe("category sync — create", () => {
    it("a structured subcategory's name WINS the category resolution over dto.category", async () => {
      prisma.product.findFirst.mockResolvedValue(null); // name/sku checks
      prisma.trackedSubcategory.findUnique
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

      expect(prisma.trackedSubcategory.findUnique).not.toHaveBeenCalled();
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

      expect(prisma.trackedSubcategory.findUnique).not.toHaveBeenCalled();
      expect(prisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ category: "Hardware" }) }),
      );
    });

    it("a variant inheriting the parent's regulated pair also gets the synced category name", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.findUnique.mockResolvedValue({
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
      });
      prisma.trackedSubcategory.findUnique
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
      prisma.trackedSubcategory.findUnique
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
      prisma.trackedSubcategory.findUnique.mockResolvedValue({ trackedCategoryId: "sec-1" });
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
      expect(prisma.trackedSubcategory.findUnique).not.toHaveBeenCalled();
    });
  });
});
