import { lockCalls } from "../testing/lock-calls";
import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
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

    it("B990: a LEGACY formula-led parent category is NEUTRALISED (not inherited, not refused): the variant is still created", async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: "p1",
        unit: "case",
        pricePerUnit: "10.00",
        priceTier2: "9.50",
        priceTier3: "9.00",
        priceTier4: "8.50",
        priceTier5: "8.00",
        category: "=LEGACY",
        unitsPerBox: 12,
        costingMethod: "FIFO",
        standardCost: null,
        isTobacco: false,
      });
      await expect(
        service.createVariant({ parentProductId: "p1", variantName: "Jalapeño" }),
      ).resolves.toBeDefined();
      const dto = products.create.mock.calls[0][0];
      expect(dto.category).toBeUndefined();
      expect(dto.name).toBe("Jalapeño");
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

    it("B990: refuses a CHANGED formula-led category with a labelled 400 and writes nothing", async () => {
      prisma.product.findUnique.mockResolvedValue({ id: "n1", category: "Drinks" });
      const err: any = await service
        .completeSetup("n1", { category: "=HYPERLINK(1)" })
        .catch((e) => e);
      expect(err.getResponse()).toMatchObject({
        code: "TEXT_CELL_FORMULA_LEAD",
        field: "category",
      });
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("B990: an unchanged legacy category does not block confirming the other fields", async () => {
      prisma.product.findUnique.mockResolvedValue({ id: "n1", category: "=LEGACY" });
      prisma.product.update.mockResolvedValue({ id: "n1", detailsIncomplete: false });
      await expect(
        service.completeSetup("n1", { category: "=LEGACY", pricePerUnit: 5 }),
      ).resolves.toBeDefined();
    });

    describe("units_v1: the pack it writes must keep the product's levels valid", () => {
      const lockingTx = (exec: jest.Mock) =>
        prisma.tenantTransaction.mockImplementationOnce((fn: any) =>
          fn({
            ...prisma.forTenant(),
            $executeRaw: exec,
            $queryRaw: jest.fn().mockResolvedValue([]),
          }),
        );

      it("a product with a level Crate cannot be completed with unit Crate (409, nothing written)", async () => {
        prisma.product.findUnique.mockResolvedValue({ id: "n1", unit: "Each", unitsPerBox: 24 });
        prisma.productUnit.findMany.mockResolvedValue([{ label: "Crate", factorToBase: 12 }]);
        const exec = jest.fn().mockResolvedValue(0);
        lockingTx(exec);
        await expect(service.completeSetup("n1", { unit: "crate" })).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(prisma.product.update).not.toHaveBeenCalled();
      });

      it("a size that lands on a level's factor is refused too", async () => {
        prisma.product.findUnique.mockResolvedValue({ id: "n1", unit: "Box", unitsPerBox: 24 });
        prisma.productUnit.findMany.mockResolvedValue([{ label: "Case", factorToBase: 12 }]);
        lockingTx(jest.fn().mockResolvedValue(0));
        await expect(service.completeSetup("n1", { unitsPerBox: 12 })).rejects.toBeInstanceOf(
          ConflictException,
        );
      });

      it("lock order: tenant units (shared) -> the product's units lock -> product read -> levels read -> write", async () => {
        prisma.product.findUnique.mockResolvedValue({ id: "n1", unit: "Each", unitsPerBox: 24 });
        prisma.product.update.mockResolvedValue({ id: "n1" });
        prisma.productUnit.findMany.mockResolvedValue([]);
        const exec = jest.fn().mockResolvedValue(0);
        lockingTx(exec);
        await service.completeSetup("n1", { unit: "Case" });
        const locks = lockCalls(exec);
        const [s0, ...v0] = locks.calls[0];
        const [s1, ...v1] = locks.calls[1];
        expect(s0.join("?")).toContain("pg_advisory_xact_lock_shared(");
        expect(v0).toEqual(["tenant-units", "test-tenant"]);
        expect(s1.join("?")).toContain("hashtext('product-units')");
        expect(v1).toEqual(["n1"]);
        expect(locks.order[1]).toBeLessThan(prisma.product.findUnique.mock.invocationCallOrder[0]);
        expect(prisma.product.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.productUnit.findMany.mock.invocationCallOrder[0],
        );
        expect(prisma.productUnit.findMany.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.product.update.mock.invocationCallOrder[0],
        );
      });

      it("SA-810 G6c: at the 200-unit cap an import confirmation of a NEW pack word saves and never touches the unit list", async () => {
        // completeSetup writes Product.unit TEXT only (a names list is never a math source): it adds no
        // TenantUnit, so the cap can neither refuse it nor be exceeded by it. Each row saves on its own.
        prisma.tenantUnit.count.mockResolvedValue(200);
        prisma.product.findUnique.mockResolvedValue({ id: "n1", unit: "Each", unitsPerBox: 24 });
        prisma.product.update.mockResolvedValue({ id: "n1", unit: "12ct" });
        prisma.productUnit.findMany.mockResolvedValue([]);
        lockingTx(jest.fn().mockResolvedValue(0));
        await expect(service.completeSetup("n1", { unit: "12ct" })).resolves.toMatchObject({
          unit: "12ct",
        });
        prisma.product.findUnique.mockResolvedValue({ id: "n2", unit: "Each", unitsPerBox: 24 });
        prisma.product.update.mockResolvedValue({ id: "n2", unit: "24pk" });
        lockingTx(jest.fn().mockResolvedValue(0));
        await expect(service.completeSetup("n2", { unit: "24pk" })).resolves.toMatchObject({
          unit: "24pk",
        });
        for (const m of ["create", "createMany", "update", "updateMany", "upsert"] as const) {
          expect(prisma.tenantUnit[m]).not.toHaveBeenCalled();
        }
      });

      it("a price or category confirmation takes no units lock and reads no levels", async () => {
        prisma.product.findUnique.mockResolvedValue({ id: "n1" });
        prisma.product.update.mockResolvedValue({ id: "n1" });
        const exec = jest.fn().mockResolvedValue(0);
        lockingTx(exec);
        await service.completeSetup("n1", { pricePerUnit: 5 });
        expect(lockCalls(exec).calls.filter(([, ...v]) => v[0] === "tenant-units")).toEqual([]);
        expect(prisma.productUnit.findMany).not.toHaveBeenCalled();
      });
    });

    it("throws when the product does not exist", async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.completeSetup("nope", {})).rejects.toBeInstanceOf(NotFoundException);
    });

    // #2728 M1 F1: unitsPerBox feeds planBarcodeRows, so confirming it on a product that already
    // has a barcode must re-sync ProductBarcode rows — a product with barcode X and upb null going
    // to upb 12 must land BOX (ENTERED) + UNIT (COPIED) rows, not leave the single legacy UNIT row.
    it("syncs ProductBarcode rows (BOX ENTERED + UNIT COPIED) when unitsPerBox is confirmed on a barcoded product", async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: "n1",
        barcode: "0000000000012",
        unitsPerBox: null,
      });
      prisma.product.update.mockResolvedValue({
        id: "n1",
        barcode: "0000000000012",
        unitsPerBox: 12,
      });
      prisma.productBarcode.findMany.mockResolvedValue([]);
      await service.completeSetup("n1", { unitsPerBox: 12 });
      expect(prisma.productBarcode.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            productId: "n1",
            code: "0000000000012",
            level: "BOX",
            origin: "ENTERED",
            primaryFor: "BOX",
          }),
          expect.objectContaining({
            productId: "n1",
            code: "0000000000012",
            level: "UNIT",
            origin: "COPIED",
            primaryFor: "UNIT",
          }),
        ],
      });
    });
  });
});
