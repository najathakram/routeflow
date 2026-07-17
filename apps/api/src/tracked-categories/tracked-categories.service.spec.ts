import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TrackedCategoriesService } from "./tracked-categories.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("TrackedCategoriesService", () => {
  let service: TrackedCategoriesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [TrackedCategoriesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(TrackedCategoriesService);
  });

  describe("findAll", () => {
    it("filters by search + active and maps _count.products → productCount", async () => {
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "c1", name: "Tobacco", active: true, _count: { products: 3 } },
      ]);

      const result = await service.findAll({ search: "tob", active: true });

      const where = prisma.trackedCategory.findMany.mock.calls[0][0].where;
      expect(where.name).toEqual({ contains: "tob", mode: "insensitive" });
      expect(where.active).toBe(true);
      expect(result[0]).toMatchObject({ id: "c1", productCount: 3 });
      expect((result[0] as any)._count).toBeUndefined();
    });

    it("passes an empty filter when no query is given", async () => {
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      await service.findAll({});
      expect(prisma.trackedCategory.findMany.mock.calls[0][0].where).toEqual({});
    });
  });

  describe("findOne", () => {
    it("throws NotFound when the category does not exist (or is cross-tenant)", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue(null);
      await expect(service.findOne("missing")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("create", () => {
    it("injects the tenantId and persists the category", async () => {
      prisma.trackedCategory.create.mockResolvedValue({
        id: "c1",
        name: "Alcohol",
        _count: { products: 0 },
      });
      const result = await service.create({ name: "Alcohol" });
      expect(prisma.trackedCategory.create).toHaveBeenCalledWith({
        data: { name: "Alcohol", tenantId: "test-tenant" },
        include: { _count: { select: { products: true } } },
      });
      expect(result).toMatchObject({ id: "c1", productCount: 0 });
    });

    it("maps a unique-constraint violation to a 409 Conflict", async () => {
      prisma.trackedCategory.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
      );
      await expect(service.create({ name: "Tobacco" })).rejects.toBeInstanceOf(ConflictException);
    });

    it("rejects when there is no tenant context (SUPER_ADMIN)", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(service.create({ name: "Alcohol" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("RF-4: rejects a tax-inclusive category with a non-zero rate (not yet supported)", async () => {
      await expect(
        service.create({
          name: "Beverage CRV",
          taxType: "PERCENT_OF_SALE",
          rate: 0.05,
          priceIncludesTax: true,
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
    });

    it("RF-4: ALLOWS a tax-inclusive category when the rate is 0 (nothing to double-count)", async () => {
      prisma.trackedCategory.create.mockResolvedValue({
        id: "c9",
        name: "Deposit",
        _count: { products: 0 },
      });
      await expect(
        service.create({
          name: "Deposit",
          taxType: "NONE",
          rate: 0,
          priceIncludesTax: true,
        } as any),
      ).resolves.toBeDefined();
    });
  });

  describe("toggle", () => {
    it("flips the active flag", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.trackedCategory.update.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: false,
        _count: { products: 0 },
      });
      await service.toggle("c1");
      expect(prisma.trackedCategory.update).toHaveBeenCalledWith({
        where: { id: "c1" },
        data: { active: false },
        include: { _count: { select: { products: true } } },
      });
    });
  });

  describe("assignProducts", () => {
    it("sets trackedCategoryId on the given products and returns the count", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.updateMany.mockResolvedValue({ count: 2 });

      const res = await service.assignProducts("c1", ["p1", "p2"]);

      expect(prisma.product.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1", "p2"] } },
        data: { trackedCategoryId: "c1" },
      });
      expect(res).toEqual({ assigned: 2 });
    });

    it("only unassigns products currently in the category", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.unassignProducts("c1", ["p1"]);

      expect(prisma.product.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1"] }, trackedCategoryId: "c1" },
        data: { trackedCategoryId: null },
      });
      expect(res).toEqual({ unassigned: 1 });
    });
  });

  describe("subcategories", () => {
    const section = { id: "c1", name: "Tobacco", active: true, _count: { products: 0 } };

    describe("listSubcategories", () => {
      it("lists a section's subcategories mapped with productCount", async () => {
        prisma.trackedCategory.findUnique.mockResolvedValue(section);
        prisma.trackedSubcategory.findMany.mockResolvedValue([
          {
            id: "s1",
            name: "Cigarettes",
            trackedCategoryId: "c1",
            active: true,
            _count: { products: 4 },
          },
        ]);

        const res = await service.listSubcategories("c1");

        expect(prisma.trackedSubcategory.findMany).toHaveBeenCalledWith({
          where: { trackedCategoryId: "c1" },
          orderBy: { name: "asc" },
          include: { _count: { select: { products: true } } },
        });
        expect(res[0]).toMatchObject({ id: "s1", productCount: 4 });
        expect((res[0] as any)._count).toBeUndefined();
      });

      it("throws NotFound when the parent section is missing", async () => {
        prisma.trackedCategory.findUnique.mockResolvedValue(null);
        await expect(service.listSubcategories("missing")).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });

    describe("createSubcategory", () => {
      it("injects tenantId + parent section and returns productCount", async () => {
        prisma.trackedCategory.findUnique.mockResolvedValue(section);
        prisma.trackedSubcategory.create.mockResolvedValue({
          id: "s1",
          name: "Cigarettes",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });

        const res = await service.createSubcategory("c1", { name: "Cigarettes" });

        expect(prisma.trackedSubcategory.create).toHaveBeenCalledWith({
          data: {
            name: "Cigarettes",
            active: true,
            trackedCategoryId: "c1",
            tenantId: "test-tenant",
          },
          include: { _count: { select: { products: true } } },
        });
        expect(res).toMatchObject({ id: "s1", productCount: 0 });
      });

      it("maps a duplicate name (P2002) to a 409 Conflict", async () => {
        prisma.trackedCategory.findUnique.mockResolvedValue(section);
        prisma.trackedSubcategory.create.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
        );
        await expect(
          service.createSubcategory("c1", { name: "Cigarettes" }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it("rejects without a tenant context", async () => {
        prisma.trackedCategory.findUnique.mockResolvedValue(section);
        prisma.getTenantId.mockReturnValue(null);
        await expect(service.createSubcategory("c1", { name: "X" })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    });

    describe("update / toggle (section-scoped)", () => {
      it("throws NotFound when the subcategory belongs to a different section", async () => {
        prisma.trackedSubcategory.findUnique.mockResolvedValue({
          id: "s1",
          trackedCategoryId: "OTHER",
          active: true,
          _count: { products: 0 },
        });
        await expect(service.updateSubcategory("c1", "s1", { name: "X" })).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });

      it("toggles active within the section", async () => {
        prisma.trackedSubcategory.findUnique.mockResolvedValue({
          id: "s1",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });
        prisma.trackedSubcategory.update.mockResolvedValue({
          id: "s1",
          trackedCategoryId: "c1",
          active: false,
          _count: { products: 0 },
        });

        await service.toggleSubcategory("c1", "s1");

        expect(prisma.trackedSubcategory.update).toHaveBeenCalledWith({
          where: { id: "s1" },
          data: { active: false },
          include: { _count: { select: { products: true } } },
        });
      });
    });
  });
});
