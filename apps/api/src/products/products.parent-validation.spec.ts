/**
 * B1211: a product's parent is judged by ONE check (`assertValidParent`) on every path that can set it:
 * create(), update() and bulkAssignParent(). Before it, `PATCH /products/:id` accepted any
 * `parentProductId` that was a UUID: it was never looked up, so a parent that does not exist in this
 * tenant, the product itself, or a variant could be written.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ProductsService } from "./products.service";
import {
  assertParentUsable,
  assertValidParent,
  PRODUCT_PARENT_REASONS,
  tenantSafeParent,
  tenantSafeParentView,
  type ParentDb,
} from "./product-parent";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { readFileSync } from "fs";
import { join } from "path";
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

/** The coded 400 body every parent refusal carries: PRODUCT_PARENT_INVALID plus the rule it failed (`reason`). */
async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).getResponse() as {
    statusCode: number;
    code: string;
    reason: string;
    message: string;
  };
}

describe("assertValidParent (the one parent check)", () => {
  const family = { id: "fam", isActive: true, kind: "FAMILY", parentProductId: null };

  it("a parent that is not in this tenant is 'not found' (the lookup carries the tenant id) and nothing else runs", async () => {
    const { db, findFirst, count } = fakeDb(null);
    const body = await refusal(
      assertValidParent(db, { tenantId: TENANT, id: "p1", parentId: "elsewhere" }),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      code: API_ERROR_CODES.PRODUCT_PARENT_INVALID,
      reason: PRODUCT_PARENT_REASONS.NOT_FOUND,
      message: "Parent product not found",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "elsewhere", tenantId: TENANT } }),
    );
    expect(count).not.toHaveBeenCalled();
  });

  it("a product cannot be its own parent, and the lookup is not even made", async () => {
    const { db, findFirst } = fakeDb(family);
    const body = await refusal(
      assertValidParent(db, { tenantId: TENANT, id: "fam", parentId: "fam" }),
    );
    expect(body).toMatchObject({
      code: API_ERROR_CODES.PRODUCT_PARENT_INVALID,
      reason: PRODUCT_PARENT_REASONS.SELF,
    });
    expect(body.message).toMatch(/own parent/);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["a parent with a parent of its own", { ...family, parentProductId: "root" }],
    ["a parent of kind VARIANT", { ...family, kind: "VARIANT" }],
  ])("refuses %s (a variant of a variant)", async (_n, parent) => {
    const { db } = fakeDb(parent);
    const body = await refusal(
      assertValidParent(db, { tenantId: TENANT, id: "p1", parentId: "fam" }),
    );
    expect(body).toMatchObject({
      code: API_ERROR_CODES.PRODUCT_PARENT_INVALID,
      reason: PRODUCT_PARENT_REASONS.VARIANT_PARENT,
      message: "Parent must be a standalone product, not a variant",
    });
  });

  it("refuses an inactive parent", async () => {
    const { db } = fakeDb({ ...family, isActive: false });
    const body = await refusal(
      assertValidParent(db, { tenantId: TENANT, id: "p1", parentId: "fam" }),
    );
    expect(body).toMatchObject({
      code: API_ERROR_CODES.PRODUCT_PARENT_INVALID,
      reason: PRODUCT_PARENT_REASONS.INACTIVE,
      message: "The parent product is inactive",
    });
  });

  it("refuses to move a product that has variants of its own (counted in this tenant)", async () => {
    const { db, count } = fakeDb(family, 2);
    const body = await refusal(
      assertValidParent(db, { tenantId: TENANT, id: "p1", parentId: "fam" }),
    );
    expect(body).toMatchObject({
      code: API_ERROR_CODES.PRODUCT_PARENT_INVALID,
      reason: PRODUCT_PARENT_REASONS.HAS_VARIANTS,
    });
    expect(body.message).toMatch(/variants of its own/);
    expect(count).toHaveBeenCalledWith({ where: { parentProductId: "p1", tenantId: TENANT } });
  });

  it("returns the parent's kind; a brand-new product (id null) has no children to count", async () => {
    const { db, count } = fakeDb(family);
    await expect(
      assertValidParent(db, { tenantId: TENANT, id: null, parentId: "fam" }),
    ).resolves.toEqual({ parentKind: "FAMILY" });
    expect(count).not.toHaveBeenCalled();
  });

  it("every reason is a distinct registered value, and no refusal is a plain-text throw", () => {
    expect(Object.values(PRODUCT_PARENT_REASONS).sort()).toEqual(
      ["HAS_VARIANTS", "INACTIVE", "NOT_FOUND", "SELF", "VARIANT_PARENT"].sort(),
    );
    const src = readFileSync(join(__dirname, "product-parent.ts"), "utf8");
    expect(src).not.toMatch(/new BadRequestException\(\s*["'`]/);
  });

  it("the create pre-check for the parent row is coded too (no plain-text 'Parent product not found' throw)", () => {
    const svc = readFileSync(join(__dirname, "products.service.ts"), "utf8");
    expect(svc).not.toMatch(/new BadRequestException\(\s*["'`]Parent product not found/);
    expect(svc).toMatch(/parentInvalid\(\s*PRODUCT_PARENT_REASONS\.NOT_FOUND/);
  });
});

describe("assertParentUsable (the judgement on a parent row the caller already loaded)", () => {
  it("accepts a standalone active row and returns its kind", () => {
    const row = { id: "p", isActive: true, kind: "FAMILY", parentProductId: null };
    expect(assertParentUsable(row)).toEqual({ parentKind: "FAMILY" });
  });

  it("refuses a variant row and an inactive row with the coded body", () => {
    for (const [row, reason] of [
      [{ id: "p", isActive: true, kind: "VARIANT", parentProductId: "x" }, "VARIANT_PARENT"],
      [{ id: "p", isActive: false, kind: "STANDARD", parentProductId: null }, "INACTIVE"],
    ] as const) {
      let body: { code?: string; reason?: string } = {};
      try {
        assertParentUsable(row);
      } catch (e) {
        body = (e as BadRequestException).getResponse() as typeof body;
      }
      expect(body).toMatchObject({ code: API_ERROR_CODES.PRODUCT_PARENT_INVALID, reason });
    }
  });
});

describe("tenantSafeParent / tenantSafeParentView (read side of the parent rule)", () => {
  const own = { id: "fam", name: "Family", tenantId: TENANT };

  it("keeps a parent of this tenant, drops one of another tenant, and fails closed when the row carries no tenantId", () => {
    expect(tenantSafeParent(own, TENANT)).toBe(own);
    expect(tenantSafeParent({ ...own, tenantId: "other-tenant" }, TENANT)).toBeNull();
    expect(
      tenantSafeParent({ id: "fam", name: "Family" } as { tenantId?: string | null }, TENANT),
    ).toBeNull();
    expect(tenantSafeParent(null, TENANT)).toBeNull();
    expect(tenantSafeParent(undefined, TENANT)).toBeNull();
  });

  it("with no tenant (null, undefined or empty) it fails closed: a parent is never returned", () => {
    expect(tenantSafeParent(own, null)).toBeNull();
    expect(tenantSafeParent(own, undefined)).toBeNull();
    expect(tenantSafeParent(own, "")).toBeNull();
    expect(tenantSafeParentView(own, "")).toBeNull();
  });

  it("the view form removes tenantId from what it returns (and returns null for a foreign parent)", () => {
    expect(tenantSafeParentView(own, TENANT)).toEqual({ id: "fam", name: "Family" });
    expect(tenantSafeParentView({ ...own, tenantId: "other-tenant" }, TENANT)).toBeNull();
    expect(own.tenantId).toBe(TENANT); // the input row is not mutated
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

  /** H2's read-only label plan walks the family chain: every family asked for is a standalone, unlabelled row. */
  function standaloneChains() {
    prisma.product.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: string[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id, parentProductId: null })),
    );
    prisma.productCategoryLabel.findMany.mockResolvedValue([]);
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
    standaloneChains();
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
      const body = await refusal(
        service.update("prod-1", { parentProductId: "other-tenant-product" } as never, {
          packPrecondition: "internal",
        }),
      );
      expect(body).toMatchObject({
        code: API_ERROR_CODES.PRODUCT_PARENT_INVALID,
        reason: PRODUCT_PARENT_REASONS.NOT_FOUND,
      });
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("itself as parent: 400, nothing written", async () => {
      seed({ "prod-1": { ...FAMILY, id: "prod-1" } });
      const body = await refusal(
        service.update("prod-1", { parentProductId: "prod-1" } as never, {
          packPrecondition: "internal",
        }),
      );
      expect(body.reason).toBe(PRODUCT_PARENT_REASONS.SELF);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a parent that is a variant: 400, nothing written", async () => {
      seed({ child: { ...FAMILY, id: "child", kind: "VARIANT", parentProductId: "fam" } });
      const body = await refusal(
        service.update("prod-1", { parentProductId: "child" } as never, {
          packPrecondition: "internal",
        }),
      );
      expect(body.reason).toBe(PRODUCT_PARENT_REASONS.VARIANT_PARENT);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("an inactive parent: 400, nothing written", async () => {
      seed({ fam: { ...FAMILY, isActive: false } });
      const body = await refusal(
        service.update("prod-1", { parentProductId: "fam" } as never, {
          packPrecondition: "internal",
        }),
      );
      expect(body.reason).toBe(PRODUCT_PARENT_REASONS.INACTIVE);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a product that has variants of its own cannot become a variant", async () => {
      seed({ fam: FAMILY }, 3);
      const body = await refusal(
        service.update("prod-1", { parentProductId: "fam" } as never, {
          packPrecondition: "internal",
        }),
      );
      expect(body.reason).toBe(PRODUCT_PARENT_REASONS.HAS_VARIANTS);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a FAMILY parent makes the row a VARIANT; a standalone parent leaves the kind alone", async () => {
      seed({ fam: FAMILY });
      await service.update("prod-1", { parentProductId: "fam" } as never, {
        packPrecondition: "internal",
      });
      expect(prisma.product.update.mock.calls[0][0].data).toMatchObject({
        parentProductId: "fam",
        kind: "VARIANT",
      });

      prisma.product.update.mockClear();
      seed({ std: { ...FAMILY, id: "std", kind: "STANDARD" } });
      await service.update("prod-1", { parentProductId: "std" } as never, {
        packPrecondition: "internal",
      });
      const data = prisma.product.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.parentProductId).toBe("std");
      expect(data).not.toHaveProperty("kind");
    });

    it("un-parenting a VARIANT resets its kind to STANDARD; a standalone product keeps its kind untouched", async () => {
      prisma.product.findUnique.mockResolvedValue({
        ...PRODUCT,
        parentProductId: "fam",
        kind: "VARIANT",
      });
      prisma.product.findFirst.mockImplementation(async (args: { where?: { id?: string } }) =>
        args?.where?.id === "prod-1" ? { parentProductId: "fam", unitsPerBox: null } : null,
      );
      prisma.product.update.mockResolvedValue({ ...PRODUCT });
      await service.update("prod-1", { parentProductId: null } as never, {
        packPrecondition: "internal",
      });
      expect(prisma.product.update.mock.calls[0][0].data).toMatchObject({
        parentProductId: null,
        kind: "STANDARD",
      });

      prisma.product.update.mockClear();
      seed({});
      await service.update("prod-1", { description: "x" } as never, {
        packPrecondition: "internal",
      });
      expect(prisma.product.update.mock.calls[0][0].data).not.toHaveProperty("kind");
    });

    it("moving a VARIANT from a FAMILY to a STANDARD parent resets its kind to STANDARD (no orphan VARIANT)", async () => {
      seed({ std: { ...FAMILY, id: "std", kind: "STANDARD" } });
      prisma.product.findUnique.mockResolvedValue({
        ...PRODUCT,
        parentProductId: "fam",
        kind: "VARIANT",
      });
      const lookup = prisma.product.findFirst.getMockImplementation()!;
      prisma.product.findFirst.mockImplementation(async (args: { where?: { id?: string } }) =>
        args?.where?.id === "prod-1" ? { parentProductId: "fam", unitsPerBox: null } : lookup(args),
      );
      await service.update("prod-1", { parentProductId: "std" } as never, {
        packPrecondition: "internal",
      });
      expect(prisma.product.update.mock.calls[0][0].data).toMatchObject({
        parentProductId: "std",
        kind: "STANDARD",
      });
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
      await service.update("prod-1", { parentProductId: "fam", description: "x" } as never, {
        packPrecondition: "internal",
      });
      expect(prisma.product.update).toHaveBeenCalled();
    });
  });

  describe("bulkAssignParent()", () => {
    it("a parent from another tenant: 400 before any row moves", async () => {
      seed({});
      const update = jest.spyOn(service, "update");
      const body = await refusal(
        service.bulkAssignParent({
          parentProductId: "other-tenant-product",
          assignments: [{ id: "prod-1", variantName: "A" }],
        } as never),
      );
      expect(body).toMatchObject({
        code: API_ERROR_CODES.PRODUCT_PARENT_INVALID,
        reason: PRODUCT_PARENT_REASONS.NOT_FOUND,
      });
      expect(update).not.toHaveBeenCalled();
    });

    it("an inactive parent: 400 before any row moves", async () => {
      seed({ fam: { ...FAMILY, isActive: false } });
      const update = jest.spyOn(service, "update");
      const body = await refusal(
        service.bulkAssignParent({
          parentProductId: "fam",
          assignments: [{ id: "prod-1", variantName: "A" }],
        } as never),
      );
      expect(body.reason).toBe(PRODUCT_PARENT_REASONS.INACTIVE);
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

  describe("reads never follow a link into another tenant (defence in depth for a pre-existing link)", () => {
    const FOREIGN_PARENT = { id: "foreign", name: "Other Tenant Family", tenantId: "other-tenant" };
    const OWN_PARENT = { id: "fam", name: "Own Family", portalVisible: true, tenantId: TENANT };

    it("findOne: a parent of another tenant comes back null, an own parent is kept, and the variants include is tenant-scoped", async () => {
      prisma.product.findUnique.mockResolvedValue({ ...PRODUCT, parent: FOREIGN_PARENT });
      const foreign = await service.findOne("prod-1");
      expect(foreign.parent).toBeNull();
      expect(JSON.stringify(foreign)).not.toContain("Other Tenant Family");
      const include = prisma.product.findUnique.mock.calls[0][0].include;
      expect(include.variants.where).toEqual({ tenantId: TENANT });

      prisma.product.findUnique.mockResolvedValue({ ...PRODUCT, parent: OWN_PARENT });
      const own = await service.findOne("prod-1");
      expect(own.parent).toEqual(OWN_PARENT);
    });

    it("findAll: the parent summary of another tenant is null, an own one keeps its shape WITHOUT tenantId, and the variants include is tenant-scoped", async () => {
      prisma.product.findMany.mockResolvedValue([
        { ...PRODUCT, id: "a", parent: FOREIGN_PARENT },
        { ...PRODUCT, id: "b", parent: OWN_PARENT },
      ]);
      prisma.product.count.mockResolvedValue(2);
      const result = await service.findAll({ includeVariants: true, page: 1, limit: 20 } as never);
      expect(result.data[0].parent).toBeNull();
      expect(result.data[1].parent).toEqual({ id: "fam", name: "Own Family", portalVisible: true });
      const include = prisma.product.findMany.mock.calls[0][0].include;
      expect(include.parent.select).toMatchObject({ tenantId: true });
      expect(include.variants.where).toEqual({ isActive: true, tenantId: TENANT });
    });

    it("the scan lookup: a parent of another tenant comes back null and the variants include is tenant-scoped", async () => {
      prisma.product.findMany.mockResolvedValue([
        { ...PRODUCT, barcode: "BC-1", barcodes: [], parent: FOREIGN_PARENT },
      ]);
      const result = await service.findByBarcode("BC-1");
      expect(result.parent).toBeNull();
      expect(JSON.stringify(result)).not.toContain("Other Tenant Family");
      const include = prisma.product.findMany.mock.calls[0][0].include;
      expect(include.variants.where).toEqual({ isActive: true, tenantId: TENANT });
    });
  });
});
