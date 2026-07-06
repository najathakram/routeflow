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
      prisma.trackedCategory.create.mockResolvedValue({ id: "c1", name: "Alcohol" });
      await service.create({ name: "Alcohol" });
      expect(prisma.trackedCategory.create).toHaveBeenCalledWith({
        data: { name: "Alcohol", tenantId: "test-tenant" },
      });
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
  });

  describe("toggle", () => {
    it("flips the active flag", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      await service.toggle("c1");
      expect(prisma.trackedCategory.update).toHaveBeenCalledWith({
        where: { id: "c1" },
        data: { active: false },
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
});
