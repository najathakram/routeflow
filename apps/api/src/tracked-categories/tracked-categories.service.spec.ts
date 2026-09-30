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

  describe("reportColumnPrefs validation", () => {
    it("persists a valid reportColumnPrefs map generically via toData()", async () => {
      prisma.trackedCategory.create.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        _count: { products: 0 },
      });
      await service.create({
        name: "Tobacco",
        reportColumnPrefs: { TX_COMPTROLLER: ["itemType", "uom", "quantity"] },
      } as any);
      expect(prisma.trackedCategory.create).toHaveBeenCalledWith({
        data: {
          name: "Tobacco",
          tenantId: "test-tenant",
          reportColumnPrefs: { TX_COMPTROLLER: ["itemType", "uom", "quantity"] },
        },
        include: { _count: { select: { products: true } } },
      });
    });

    it("400s on an unknown template key", async () => {
      await expect(
        service.create({
          name: "Tobacco",
          reportColumnPrefs: { NOT_A_TEMPLATE: ["itemType"] },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
    });

    it("400s on an unknown column key for a valid template", async () => {
      await expect(
        service.create({
          name: "Tobacco",
          reportColumnPrefs: { TX_COMPTROLLER: ["itemType", "notARealColumn"] },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
    });

    it("400s on an empty column array", async () => {
      await expect(
        service.create({
          name: "Tobacco",
          reportColumnPrefs: { TX_COMPTROLLER: [] },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.trackedCategory.create).not.toHaveBeenCalled();
    });

    it("allows null to clear reportColumnPrefs on update", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.trackedCategory.update.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        reportColumnPrefs: null,
        _count: { products: 0 },
      });
      await service.update("c1", { reportColumnPrefs: null } as any);
      // Prisma clears a nullable Json column with `Prisma.DbNull`, not a bare null.
      expect(prisma.trackedCategory.update).toHaveBeenCalledWith({
        where: { id: "c1" },
        data: { reportColumnPrefs: Prisma.DbNull },
        include: { _count: { select: { products: true } } },
      });
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
    it("sets trackedCategoryId + clears trackedSubcategoryId on movers, returning the mover count", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.updateMany.mockResolvedValue({ count: 2 });

      const res = await service.assignProducts("c1", ["p1", "p2"]);

      expect(prisma.product.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1", "p2"] }, NOT: { trackedCategoryId: "c1" } },
        data: { trackedCategoryId: "c1", trackedSubcategoryId: null },
      });
      expect(res).toEqual({ assigned: 2, processed: 2 });
    });

    it("excludes rows already in this section from the count (movers-only semantics)", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      // Of the 3 requested ids, only the movers matched the NOT-in-section where
      // clause and got updated — the row already in "c1" is excluded by Prisma.
      // The isTobacco sync that follows spans the full id set, so its count is
      // every row the tenant can see: 1 mover + 2 already in "c1".
      prisma.product.updateMany
        .mockResolvedValueOnce({ count: 1 }) // movers
        .mockResolvedValueOnce({ count: 3 }); // isTobacco mirror, full id set

      const res = await service.assignProducts("c1", ["p1", "p2", "p3"]);

      expect(prisma.product.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1", "p2", "p3"] }, NOT: { trackedCategoryId: "c1" } },
        data: { trackedCategoryId: "c1", trackedSubcategoryId: null },
      });
      // `processed` must NOT drop the two rows already in the section — the
      // caller reports them as done, not skipped.
      expect(res).toEqual({ assigned: 1, processed: 3 });
    });

    it("only unassigns products currently in the category and clears trackedSubcategoryId", async () => {
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
        data: { trackedCategoryId: null, trackedSubcategoryId: null },
      });
      expect(res).toEqual({ unassigned: 1 });
    });

    // ── one-category-axis rule: movers' synced Product.category is cleared too ──

    it("assignProducts clears movers' SYNCED categories only — diverged/free-text survives", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", category: "Zyn", trackedSubcategory: { name: "Zyn" } }, // synced — clear
        { id: "p2", category: "My Custom Label", trackedSubcategory: { name: "Zyn" } }, // diverged — survives
        { id: "p3", category: null, trackedSubcategory: null }, // never synced — nothing to clear
      ]);
      prisma.product.updateMany.mockResolvedValue({ count: 3 });

      await service.assignProducts("c1", ["p1", "p2", "p3"]);

      expect(prisma.product.findMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1", "p2", "p3"] }, NOT: { trackedCategoryId: "c1" } },
        select: { id: true, category: true, trackedSubcategory: { select: { name: true } } },
      });
      // The synced-only clear runs BEFORE the main reassignment.
      expect(prisma.product.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: { in: ["p1"] } },
        data: { category: null },
      });
      expect(prisma.product.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: { in: ["p1", "p2", "p3"] }, NOT: { trackedCategoryId: "c1" } },
        data: { trackedCategoryId: "c1", trackedSubcategoryId: null },
      });
    });

    it("assignProducts skips the extra clear when no mover has a synced category", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", category: "Custom", trackedSubcategory: { name: "Zyn" } },
      ]);
      prisma.product.updateMany.mockResolvedValue({ count: 1 });

      await service.assignProducts("c1", ["p1"]);

      // Only the main reassignment + the (unconditional) isTobacco mirror sync —
      // the synced-category clear is skipped since nothing was synced.
      expect(prisma.product.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.product.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: { in: ["p1"] }, NOT: { trackedCategoryId: "c1" } },
        data: { trackedCategoryId: "c1", trackedSubcategoryId: null },
      });
      expect(prisma.product.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: { in: ["p1"] } },
        data: { isTobacco: true },
      });
    });

    it("unassignProducts clears movers' SYNCED categories only — diverged/free-text survives", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", category: "Zyn", trackedSubcategory: { name: "Zyn" } },
        { id: "p2", category: "My Custom Label", trackedSubcategory: { name: "Zyn" } },
      ]);
      prisma.product.updateMany.mockResolvedValue({ count: 2 });

      await service.unassignProducts("c1", ["p1", "p2"]);

      expect(prisma.product.findMany).toHaveBeenCalledWith({
        where: { id: { in: ["p1", "p2"] }, trackedCategoryId: "c1" },
        select: { id: true, category: true, trackedSubcategory: { select: { name: true } } },
      });
      expect(prisma.product.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: { in: ["p1"] } },
        data: { category: null },
      });
      expect(prisma.product.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: { in: ["p1", "p2"] }, trackedCategoryId: "c1" },
        data: { trackedCategoryId: null, trackedSubcategoryId: null },
      });
    });
  });

  // ── isTobacco write-sync (2026-08-24 tobacco→Regulated consolidation) ──────

  describe("isTobacco mirror sync (write-sync consolidation)", () => {
    it('assignProducts to a category named "Tobacco" sets isTobacco:true on the FULL id set', async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.updateMany.mockResolvedValue({ count: 2 });

      await service.assignProducts("c1", ["p1", "p2"]);

      expect(prisma.product.updateMany).toHaveBeenLastCalledWith({
        where: { id: { in: ["p1", "p2"] } },
        data: { isTobacco: true },
      });
    });

    it("assignProducts to a NON-Tobacco category sets isTobacco:false on the FULL id set", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c2",
        name: "Alcohol",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.updateMany.mockResolvedValue({ count: 1 });

      await service.assignProducts("c2", ["p1"]);

      expect(prisma.product.updateMany).toHaveBeenLastCalledWith({
        where: { id: { in: ["p1"] } },
        data: { isTobacco: false },
      });
    });

    it("assignProducts matches the Tobacco category case-insensitively", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.updateMany.mockResolvedValue({ count: 1 });

      await service.assignProducts("c1", ["p1"]);

      expect(prisma.product.updateMany).toHaveBeenLastCalledWith({
        where: { id: { in: ["p1"] } },
        data: { isTobacco: true },
      });
    });

    it("unassignProducts clears isTobacco ONLY on rows that were actually members", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      // Only p1 was actually a member of c1 (mirrors the targetWhere-scoped
      // findMany) — p2 was requested but never in this category and must not
      // be touched by the mirror write.
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", category: null, trackedSubcategory: null },
      ]);
      prisma.product.updateMany.mockResolvedValue({ count: 1 });

      await service.unassignProducts("c1", ["p1", "p2"]);

      expect(prisma.product.updateMany).toHaveBeenLastCalledWith({
        where: { id: { in: ["p1"] } },
        data: { isTobacco: false },
      });
    });

    it("unassignProducts writes no mirror update when none of the requested ids were actually members", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      prisma.product.findMany.mockResolvedValue([]); // none of the requested ids were members
      prisma.product.updateMany.mockResolvedValue({ count: 0 });

      await service.unassignProducts("c1", ["p9"]);

      // Only the main (no-op) clear — no isTobacco mirror write on an empty target set.
      expect(prisma.product.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("isTobaccoCategory (computed, on every serialized payload)", () => {
    it('findAll: true for a category named "Tobacco" case-insensitively', async () => {
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "c1", name: "tobacco", active: true, _count: { products: 0 } },
      ]);
      const result = await service.findAll({});
      expect(result[0]).toMatchObject({ isTobaccoCategory: true });
    });

    it("findAll: false for any other category name", async () => {
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "c2", name: "Alcohol", active: true, _count: { products: 0 } },
      ]);
      const result = await service.findAll({});
      expect(result[0]).toMatchObject({ isTobaccoCategory: false });
    });

    it("findOne carries isTobaccoCategory too", async () => {
      prisma.trackedCategory.findUnique.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        active: true,
        _count: { products: 0 },
      });
      const result = await service.findOne("c1");
      expect(result).toMatchObject({ isTobaccoCategory: true });
    });

    it("create/update payloads carry isTobaccoCategory too", async () => {
      prisma.trackedCategory.create.mockResolvedValue({
        id: "c1",
        name: "Tobacco",
        _count: { products: 0 },
      });
      const created = await service.create({ name: "Tobacco" });
      expect(created).toMatchObject({ isTobaccoCategory: true });
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

      it("trims the name before saving", async () => {
        prisma.trackedCategory.findUnique.mockResolvedValue(section);
        prisma.trackedSubcategory.findFirst.mockResolvedValue(null);
        prisma.trackedSubcategory.create.mockResolvedValue({
          id: "s1",
          name: "Cigarettes",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });

        await service.createSubcategory("c1", { name: "  Cigarettes  " });

        expect(prisma.trackedSubcategory.create).toHaveBeenCalledWith({
          data: {
            name: "Cigarettes",
            active: true,
            trackedCategoryId: "c1",
            tenantId: "test-tenant",
          },
          include: { _count: { select: { products: true } } },
        });
      });

      it("rejects a name that is empty after trimming", async () => {
        prisma.trackedCategory.findUnique.mockResolvedValue(section);
        await expect(service.createSubcategory("c1", { name: "   " })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(prisma.trackedSubcategory.create).not.toHaveBeenCalled();
      });

      it("409s on a case-insensitive duplicate, quoting the EXISTING row's casing", async () => {
        prisma.trackedCategory.findUnique.mockResolvedValue(section);
        prisma.trackedSubcategory.findFirst.mockResolvedValue({
          id: "s1",
          name: "Cigarettes",
          trackedCategoryId: "c1",
          active: true,
        });

        await expect(service.createSubcategory("c1", { name: "cigarettes" })).rejects.toMatchObject(
          {
            message: expect.stringContaining('"Cigarettes"'),
          },
        );
        expect(prisma.trackedSubcategory.create).not.toHaveBeenCalled();
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

      it("trims the name and 409s on a case-insensitive dup of a sibling (existing casing quoted)", async () => {
        prisma.trackedSubcategory.findUnique.mockResolvedValue({
          id: "s1",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });
        prisma.trackedSubcategory.findFirst.mockResolvedValue({
          id: "s2",
          name: "Cigars",
          trackedCategoryId: "c1",
          active: true,
        });

        await expect(
          service.updateSubcategory("c1", "s1", { name: " cigars " }),
        ).rejects.toMatchObject({
          message: expect.stringContaining('"Cigars"'),
        });
        expect(prisma.trackedSubcategory.findFirst).toHaveBeenCalledWith({
          where: {
            trackedCategoryId: "c1",
            id: { not: "s1" },
            name: { equals: "cigars", mode: "insensitive" },
          },
        });
        expect(prisma.trackedSubcategory.update).not.toHaveBeenCalled();
      });

      it("allows a case-only rename of its own row (self excluded from the dup check)", async () => {
        prisma.trackedSubcategory.findUnique.mockResolvedValue({
          id: "s1",
          name: "Cigarettes",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });
        prisma.trackedSubcategory.findFirst.mockResolvedValue(null);
        prisma.trackedSubcategory.update.mockResolvedValue({
          id: "s1",
          name: "CIGARETTES",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });

        const res = await service.updateSubcategory("c1", "s1", { name: "CIGARETTES" });

        expect(prisma.trackedSubcategory.update).toHaveBeenCalledWith({
          where: { id: "s1" },
          data: { name: "CIGARETTES" },
          include: { _count: { select: { products: true } } },
        });
        expect(res).toMatchObject({ id: "s1", name: "CIGARETTES" });
      });

      it("rejects a rename to an empty (post-trim) name", async () => {
        prisma.trackedSubcategory.findUnique.mockResolvedValue({
          id: "s1",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });
        await expect(service.updateSubcategory("c1", "s1", { name: "   " })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(prisma.trackedSubcategory.update).not.toHaveBeenCalled();
      });

      // ── one-category-axis rule: rename propagates to synced products ──

      it("propagates a rename to synced (category===oldName) and never-synced (category IS NULL) products", async () => {
        prisma.trackedSubcategory.findUnique.mockResolvedValue({
          id: "s1",
          name: "Zyn",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });
        prisma.trackedSubcategory.findFirst.mockResolvedValue(null); // no dup
        prisma.trackedSubcategory.update.mockResolvedValue({
          id: "s1",
          name: "Zyn Pouches",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });
        prisma.product.updateMany.mockResolvedValue({ count: 4 });

        await service.updateSubcategory("c1", "s1", { name: "Zyn Pouches" });

        expect(prisma.product.updateMany).toHaveBeenCalledWith({
          where: {
            trackedSubcategoryId: "s1",
            OR: [{ category: "Zyn" }, { category: null }],
          },
          data: { category: "Zyn Pouches" },
        });
      });

      it("does NOT propagate when the name is unchanged (e.g. only `active` toggled)", async () => {
        prisma.trackedSubcategory.findUnique.mockResolvedValue({
          id: "s1",
          name: "Zyn",
          trackedCategoryId: "c1",
          active: true,
          _count: { products: 0 },
        });
        prisma.trackedSubcategory.update.mockResolvedValue({
          id: "s1",
          name: "Zyn",
          trackedCategoryId: "c1",
          active: false,
          _count: { products: 0 },
        });

        await service.updateSubcategory("c1", "s1", { active: false });

        expect(prisma.product.updateMany).not.toHaveBeenCalled();
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
