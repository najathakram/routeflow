/**
 * B1211: a product's parent is judged by ONE check (`assertValidParent`) on every path that can set it:
 * create(), update() and bulkAssignParent(). Before it, `PATCH /products/:id` accepted any
 * `parentProductId` that was a UUID: it was never looked up, so a parent that does not exist in this
 * tenant, the product itself, or a variant could be written.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { assertValidParent, type ParentDb } from "./product-parent";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";

const TENANT = "t-1";

type ParentRow = {
  id: string;
  isActive: boolean;
  kind: string;
  parentProductId: string | null;
} | null;

function fakeDb(parent: ParentRow, children = 0) {
  const findFirst = jest.fn().mockResolvedValue(parent);
  const count = jest.fn().mockResolvedValue(children);
  return { db: { product: { findFirst, count } } as ParentDb, findFirst, count };
}

describe("assertValidParent (the one parent check)", () => {
  const family = { id: "fam", isActive: true, kind: "FAMILY", parentProductId: null };

  it("a parent that is not in this tenant is 'not found' (the lookup carries the tenant id) and nothing else runs", async () => {
    const { db, findFirst, count } = fakeDb(null);
    await expect(
      assertValidParent(db, { tenantId: TENANT, id: "p1", parentId: "elsewhere" }),
    ).rejects.toThrow(new BadRequestException("Parent product not found"));
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "elsewhere", tenantId: TENANT } }),
    );
    expect(count).not.toHaveBeenCalled();
  });

  it("a product cannot be its own parent, and the lookup is not even made", async () => {
    const { db, findFirst } = fakeDb(family);
    await expect(
      assertValidParent(db, { tenantId: TENANT, id: "fam", parentId: "fam" }),
    ).rejects.toThrow(/own parent/);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["a parent with a parent of its own", { ...family, parentProductId: "root" }],
    ["a parent of kind VARIANT", { ...family, kind: "VARIANT" }],
  ])("refuses %s (a variant of a variant)", async (_n, parent) => {
    const { db } = fakeDb(parent);
    await expect(
      assertValidParent(db, { tenantId: TENANT, id: "p1", parentId: "fam" }),
    ).rejects.toThrow("Parent must be a standalone product, not a variant");
  });

  it("refuses an inactive parent", async () => {
    const { db } = fakeDb({ ...family, isActive: false });
    await expect(
      assertValidParent(db, { tenantId: TENANT, id: "p1", parentId: "fam" }),
    ).rejects.toThrow("The parent product is inactive");
  });

  it("refuses to move a product that has variants of its own (counted in this tenant)", async () => {
    const { db, count } = fakeDb(family, 2);
    await expect(
      assertValidParent(db, { tenantId: TENANT, id: "p1", parentId: "fam" }),
    ).rejects.toThrow(/variants of its own/);
    expect(count).toHaveBeenCalledWith({ where: { parentProductId: "p1", tenantId: TENANT } });
  });

  it("returns the parent's kind; a brand-new product (id null) has no children to count", async () => {
    const { db, count } = fakeDb(family);
    await expect(
      assertValidParent(db, { tenantId: TENANT, id: null, parentId: "fam" }),
    ).resolves.toEqual({ parentKind: "FAMILY" });
    expect(count).not.toHaveBeenCalled();
  });
});

describe("ProductsService: every parent write goes through it (B1211)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const PRODUCT = {
    id: "prod-1",
    name: "Cherry Tomatoes",
    sku: "TOM-001",
    unit: "punnet",
    pricePerUnit: 4.99,
    category: "Produce",
    isActive: true,
    kind: "STANDARD",
    parentProductId: null,
    imageKeys: [] as string[],
    variants: [],
    barcodes: [],
    images: [],
  };

  /** Rows by id for the parent lookups; the product itself answers the recipe guard's fresh read. */
  function seed(parents: Record<string, ParentRow>, childCount = 0) {
    prisma.product.findUnique.mockResolvedValue(PRODUCT);
    prisma.product.findFirst.mockImplementation(async (args: { where?: { id?: string } }) => {
      const id = args?.where?.id;
      if (id === "prod-1") return { parentProductId: null, unitsPerBox: null };
      return id && id in parents ? parents[id] : null;
    });
    prisma.product.count.mockResolvedValue(childCount);
    prisma.product.update.mockResolvedValue({ ...PRODUCT });
    prisma.recipe.findFirst.mockResolvedValue(null);
    prisma.recipe.findMany.mockResolvedValue([]);
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn(),
            presignedUrls: jest.fn().mockResolvedValue([]),
            upload: jest.fn(),
            delete: jest.fn(),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
    (prisma as unknown as { getTenantId: jest.Mock }).getTenantId = jest
      .fn()
      .mockReturnValue(TENANT);
  });

  const FAMILY: ParentRow = { id: "fam", isActive: true, kind: "FAMILY", parentProductId: null };

  describe("update()", () => {
    it("a parent id that is not in this tenant is refused and NOTHING is written", async () => {
      seed({}); // the lookup (tenant-scoped) finds nothing
      await expect(
        service.update("prod-1", { parentProductId: "other-tenant-product" } as never),
      ).rejects.toThrow("Parent product not found");
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("itself as parent: 400, nothing written", async () => {
      seed({ "prod-1": { ...FAMILY, id: "prod-1" } });
      await expect(
        service.update("prod-1", { parentProductId: "prod-1" } as never),
      ).rejects.toThrow(/own parent/);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a parent that is a variant: 400, nothing written", async () => {
      seed({ child: { ...FAMILY, id: "child", kind: "VARIANT", parentProductId: "fam" } });
      await expect(service.update("prod-1", { parentProductId: "child" } as never)).rejects.toThrow(
        "Parent must be a standalone product, not a variant",
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("an inactive parent: 400, nothing written", async () => {
      seed({ fam: { ...FAMILY, isActive: false } });
      await expect(service.update("prod-1", { parentProductId: "fam" } as never)).rejects.toThrow(
        "The parent product is inactive",
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a product that has variants of its own cannot become a variant", async () => {
      seed({ fam: FAMILY }, 3);
      await expect(service.update("prod-1", { parentProductId: "fam" } as never)).rejects.toThrow(
        /variants of its own/,
      );
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a FAMILY parent makes the row a VARIANT; a standalone parent leaves the kind alone", async () => {
      seed({ fam: FAMILY });
      await service.update("prod-1", { parentProductId: "fam" } as never);
      expect(prisma.product.update.mock.calls[0][0].data).toMatchObject({
        parentProductId: "fam",
        kind: "VARIANT",
      });

      prisma.product.update.mockClear();
      seed({ std: { ...FAMILY, id: "std", kind: "STANDARD" } });
      await service.update("prod-1", { parentProductId: "std" } as never);
      const data = prisma.product.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.parentProductId).toBe("std");
      expect(data).not.toHaveProperty("kind");
    });

    it("an echo of the CURRENT parent is not re-judged (an archived family must not block editing its variants)", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...PRODUCT,
        parentProductId: "fam",
        kind: "VARIANT",
      });
      prisma.product.findFirst.mockImplementation(async (args: { where?: { id?: string } }) =>
        args?.where?.id === "fam" ? { ...FAMILY, isActive: false } : null,
      );
      prisma.product.update.mockResolvedValue({ ...PRODUCT });
      await service.update("prod-1", { parentProductId: "fam", description: "x" } as never);
      expect(prisma.product.update).toHaveBeenCalled();
    });
  });

  describe("bulkAssignParent()", () => {
    it("a parent from another tenant: 400 before any row moves", async () => {
      seed({});
      const update = jest.spyOn(service, "update");
      await expect(
        service.bulkAssignParent({
          parentProductId: "other-tenant-product",
          assignments: [{ id: "prod-1", variantName: "A" }],
        } as never),
      ).rejects.toThrow("Parent product not found");
      expect(update).not.toHaveBeenCalled();
    });

    it("an inactive parent: 400 before any row moves", async () => {
      seed({ fam: { ...FAMILY, isActive: false } });
      const update = jest.spyOn(service, "update");
      await expect(
        service.bulkAssignParent({
          parentProductId: "fam",
          assignments: [{ id: "prod-1", variantName: "A" }],
        } as never),
      ).rejects.toThrow("The parent product is inactive");
      expect(update).not.toHaveBeenCalled();
    });

    it("assigning the parent to itself is reported as a failed row, not written", async () => {
      seed({ fam: FAMILY });
      prisma.product.findUnique.mockResolvedValue({ ...PRODUCT, id: "fam" });
      const result = await service.bulkAssignParent({
        parentProductId: "fam",
        assignments: [{ id: "fam", variantName: "A" }],
      } as never);
      expect(result.succeeded).toEqual([]);
      expect(result.failed[0]).toMatchObject({ id: "fam" });
      expect(result.failed[0].reason).toMatch(/own parent/);
    });
  });
});
