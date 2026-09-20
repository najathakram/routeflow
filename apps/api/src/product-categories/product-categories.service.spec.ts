import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ProductCategoriesService } from "./product-categories.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { activeRuleWhere } from "../selling-restrictions/selling-restrictions.core";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const user = { sub: "u1", username: "admin" } as JwtPayload;
const stub = () => ({
  findMany: jest.fn().mockResolvedValue([]),
  findFirst: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn().mockResolvedValue({ count: 1 }),
});

function row(over: Record<string, unknown> = {}, labels = 2, active = 0) {
  return {
    id: "c1",
    name: "Alcohol",
    archivedAt: null,
    createdAt: new Date("2026-09-19T00:00:00Z"),
    _count: { labels, sellingRestrictions: active },
    ...over,
  };
}

describe("ProductCategoriesService", () => {
  let service: ProductCategoriesService;
  let cat: ReturnType<typeof stub>;
  let audit: { log: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    cat = stub();
    (prisma.forTenant() as any).productCategory = cat;
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        ProductCategoriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(ProductCategoriesService);
  });

  describe("list", () => {
    it("hides archived by default and maps the counts", async () => {
      cat.findMany.mockResolvedValue([row({}, 3, 1)]);
      const out = await service.list();
      expect(cat.findMany.mock.calls[0][0].where).toEqual({ archivedAt: null });
      expect(out).toEqual([
        {
          id: "c1",
          name: "Alcohol",
          archivedAt: null,
          createdAt: "2026-09-19T00:00:00.000Z",
          productCount: 3,
          activeRestrictionCount: 1,
        },
      ]);
    });

    it("refuses without a tenant context (would list every tenant's categories together)", async () => {
      (prisma.getTenantId as jest.Mock).mockReturnValue(null);
      await expect(service.list()).rejects.toBeInstanceOf(BadRequestException);
      expect(cat.findMany).not.toHaveBeenCalled();
    });

    it("includes archived when asked", async () => {
      await service.list(true);
      expect(cat.findMany.mock.calls[0][0].where).toEqual({});
    });

    it("counts only INCLUDE labels, and rules with the ENGINE's own active predicate (no local copy)", async () => {
      await service.list();
      const counts = cat.findMany.mock.calls[0][0].select._count.select;
      expect(counts.labels).toEqual({ where: { mode: "INCLUDE" } });
      const where = counts.sellingRestrictions.where;
      // Same shape as `activeRuleWhere` for the very instant the query used — incl. effectiveFrom.
      expect(where.effectiveFrom).toEqual({ lte: expect.any(Date) });
      expect(where).toEqual(activeRuleWhere(where.effectiveFrom.lte));
    });
  });

  describe("create", () => {
    it("stamps the tenant, audits, and returns the dto", async () => {
      cat.create.mockResolvedValue(row({ name: "THC" }, 0));
      const out = await service.create({ name: "THC" }, user);
      expect(cat.create.mock.calls[0][0].data).toEqual({ name: "THC", tenantId: "test-tenant" });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "product_category.created", userId: "u1" }),
      );
      expect(out.name).toBe("THC");
    });

    it("maps a duplicate name to 409", async () => {
      cat.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      await expect(service.create({ name: "THC" }, user)).rejects.toBeInstanceOf(ConflictException);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("refuses without a tenant context (SUPER_ADMIN)", async () => {
      (prisma.getTenantId as jest.Mock).mockReturnValue(null);
      await expect(service.create({ name: "THC" }, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("update", () => {
    it("404s an unknown / cross-tenant category", async () => {
      await expect(service.update("nope", { name: "X" }, user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("refuses to archive while a rule in force targets the category — the guard is IN the write's WHERE", async () => {
      cat.findFirst.mockResolvedValue(row({}, 2, 1));
      cat.updateMany.mockResolvedValue({ count: 0 }); // the atomic guard matched nothing
      await expect(service.update("c1", { archived: true }, user)).rejects.toBeInstanceOf(
        ConflictException,
      );
      const where = cat.updateMany.mock.calls[0][0].where;
      expect(where.id).toBe("c1");
      expect(where.sellingRestrictions).toEqual({
        none: activeRuleWhere(where.sellingRestrictions.none.effectiveFrom.lte),
      });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("archives a category with no active rules and audits it", async () => {
      cat.findFirst
        .mockResolvedValueOnce(row({}, 2, 0))
        .mockResolvedValueOnce(row({ archivedAt: new Date() }, 2, 0));
      const out = await service.update("c1", { archived: true }, user);
      expect(cat.updateMany.mock.calls[0][0].data.archivedAt).toBeInstanceOf(Date);
      expect(out.archivedAt).not.toBeNull();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "product_category.updated" }),
      );
    });

    it("a write that matched nothing without an archive guard is a 404 (row vanished), never a null dereference", async () => {
      cat.findFirst.mockResolvedValue(row());
      cat.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update("c1", { name: "New" }, user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("an archive that matches nothing because the row VANISHED is a 404, not a bogus 'active rules' 409", async () => {
      cat.findFirst.mockResolvedValueOnce(row({}, 2, 0)).mockResolvedValueOnce(null);
      cat.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update("c1", { archived: true }, user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("refuses without a tenant context (SUPER_ADMIN's unscoped client would cross tenants)", async () => {
      (prisma.getTenantId as jest.Mock).mockReturnValue(null);
      await expect(service.update("c1", { name: "X" }, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(cat.updateMany).not.toHaveBeenCalled();
    });

    it("restores an archived category (archived:false clears archivedAt)", async () => {
      cat.findFirst
        .mockResolvedValueOnce(row({ archivedAt: new Date() }))
        .mockResolvedValueOnce(row());
      await service.update("c1", { archived: false }, user);
      expect(cat.updateMany.mock.calls[0][0].data.archivedAt).toBeNull();
      expect(cat.updateMany.mock.calls[0][0].where.sellingRestrictions).toBeUndefined();
    });

    it("a no-op patch writes and audits nothing", async () => {
      cat.findFirst.mockResolvedValue(row());
      await service.update("c1", {}, user);
      expect(cat.updateMany).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("maps a rename collision to 409", async () => {
      cat.findFirst.mockResolvedValue(row());
      cat.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      await expect(service.update("c1", { name: "Dup" }, user)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
