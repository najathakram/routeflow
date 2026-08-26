import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductAliasService } from "./product-alias.service";

describe("ProductAliasService", () => {
  let service: ProductAliasService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [ProductAliasService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(ProductAliasService);
  });

  describe("normalize", () => {
    it("uppercases and collapses whitespace", () => {
      expect(service.normalize("  Cloud   Chips  bbq ")).toBe("CLOUD CHIPS BBQ");
    });
  });

  describe("resolve", () => {
    it("prefers a supplier-specific alias over the any-supplier fallback", async () => {
      prisma.productAlias.findMany.mockResolvedValue([
        { supplierId: "", productId: "any", expenseCategoryId: null },
        { supplierId: "sup1", productId: "specific", expenseCategoryId: null },
      ]);
      prisma.product.findFirst.mockResolvedValue({ id: "specific" });
      const target = await service.resolve("sup1", "cloud chips");
      expect(target).toEqual({ productId: "specific", expenseCategoryId: null });
    });

    it("returns null when nothing is learned", async () => {
      prisma.productAlias.findMany.mockResolvedValue([]);
      await expect(service.resolve("sup1", "unknown")).resolves.toBeNull();
    });

    it("drops a dangling product pointer but keeps the expense-category pointer", async () => {
      prisma.productAlias.findMany.mockResolvedValue([
        { supplierId: "", productId: "deleted-product", expenseCategoryId: "cat-1" },
      ]);
      prisma.product.findFirst.mockResolvedValue(null); // product no longer exists
      const target = await service.resolve(null, "some deposit");
      expect(target).toEqual({ productId: null, expenseCategoryId: "cat-1" });
    });
  });

  describe("learn", () => {
    it("upserts the normalized alias under the any-supplier sentinel when no supplier", async () => {
      await service.learn(null, "  BS Pallet Deposit ", { expenseCategoryId: "cat-9" });
      expect(prisma.productAlias.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_supplierId_rawText: {
              tenantId: "test-tenant",
              supplierId: "",
              rawText: "BS PALLET DEPOSIT",
            },
          },
          create: expect.objectContaining({
            supplierId: "",
            rawText: "BS PALLET DEPOSIT",
            expenseCategoryId: "cat-9",
            productId: null,
          }),
        }),
      );
    });
  });

  describe("remove", () => {
    it("deletes tenant-scoped and reports the count", async () => {
      prisma.productAlias.deleteMany.mockResolvedValue({ count: 1 });
      await expect(service.remove("a1")).resolves.toEqual({ deleted: 1 });
    });
  });
});
