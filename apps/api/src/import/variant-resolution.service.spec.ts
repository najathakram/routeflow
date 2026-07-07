import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductsService } from "../products/products.service";
import { ProductAliasService } from "./product-alias.service";
import { VariantResolutionService } from "./variant-resolution.service";

describe("VariantResolutionService", () => {
  let service: VariantResolutionService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let products: { create: jest.Mock };
  let aliases: { learn: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    products = { create: jest.fn().mockResolvedValue({ id: "new-prod" }) };
    aliases = { learn: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        VariantResolutionService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: products },
        { provide: ProductAliasService, useValue: aliases },
      ],
    }).compile();
    service = moduleRef.get(VariantResolutionService);
  });

  describe("createVariant", () => {
    it("creates a variant inheriting the parent family's defaults", async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: "p1",
        unit: "case",
        pricePerUnit: "10.00",
        priceTier2: "9.50",
        priceTier3: "9.00",
        priceTier4: "8.50",
        priceTier5: "8.00",
        category: "Snacks",
        unitsPerBox: 12,
        costingMethod: "FIFO",
        standardCost: null,
        isTobacco: false,
      });
      await service.createVariant({ parentProductId: "p1", variantName: "Jalapeño" });
      expect(products.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Jalapeño",
          variantName: "Jalapeño",
          parentProductId: "p1",
          unit: "case",
          pricePerUnit: "10.00",
          priceTier2: "9.50",
          category: "Snacks",
          unitsPerBox: 12,
          costingMethod: "FIFO",
          isTobacco: false,
        }),
      );
    });

    it("throws when the parent does not exist", async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(
        service.createVariant({ parentProductId: "nope", variantName: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("createBrandNew", () => {
    it("sells at cost + default margin and flags details-incomplete", async () => {
      products.create.mockResolvedValue({ id: "n1" });
      prisma.product.update.mockResolvedValue({ id: "n1", detailsIncomplete: true });
      await service.createBrandNew({ name: "Cloud Chips Jalapeño 12CT", cost: 8.64 });
      expect(products.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Cloud Chips Jalapeño 12CT",
          unit: "each",
          pricePerUnit: "11.23", // roundMoney(8.64 * 1.3)
          standardCost: "8.6400",
        }),
      );
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "n1" }, data: { detailsIncomplete: true } }),
      );
    });
  });

  describe("matchExisting", () => {
    it("learns an alias to the matched product", async () => {
      await service.matchExisting({ supplierId: "s1", rawText: "CLOUD CHIPS", productId: "p9" });
      expect(aliases.learn).toHaveBeenCalledWith("s1", "CLOUD CHIPS", {
        productId: "p9",
        expenseCategoryId: undefined,
      });
    });

    it("requires a product or expense-category target", async () => {
      await expect(service.matchExisting({ rawText: "X" })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("completeSetup", () => {
    it("clears the incomplete flag and applies confirmed fields", async () => {
      prisma.product.findUnique.mockResolvedValue({ id: "n1" });
      prisma.product.update.mockResolvedValue({ id: "n1", detailsIncomplete: false });
      await service.completeSetup("n1", { pricePerUnit: 12.5, unitsPerBox: 24 });
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pricePerUnit: "12.50",
            unitsPerBox: 24,
            detailsIncomplete: false,
          }),
        }),
      );
    });

    it("throws when the product does not exist", async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.completeSetup("nope", {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
