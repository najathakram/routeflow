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
            OR: expect.arrayContaining([expect.objectContaining({ name: expect.any(Object) })]),
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

    it("isolates per-item failures — one bad row doesn't abort the rest", async () => {
      prisma.product.findUnique.mockResolvedValue({ id: "parent-1", parentProductId: null });
      const update = jest
        .spyOn(service, "update")
        .mockResolvedValueOnce({} as any)
        .mockRejectedValueOnce(
          new Error('A variant named "Grape" already exists for this product'),
        );

      const result = await service.bulkAssignParent({
        parentProductId: "parent-1",
        assignments: [
          { id: "prod-a", variantName: "Strawberry" },
          { id: "prod-b", variantName: "Grape" },
        ],
      } as any);

      expect(result).toEqual({
        succeeded: ["prod-a"],
        failed: [
          { id: "prod-b", reason: 'A variant named "Grape" already exists for this product' },
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
});
