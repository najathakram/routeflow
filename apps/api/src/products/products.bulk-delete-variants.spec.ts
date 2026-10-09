/**
 * B1212: `bulkDelete` (and `clearAll`, which runs through it) must never hard-delete a product that
 * still has variants. The variants' parent link is SET NULL on delete, so they would fall back to
 * standalone products and could collide with an existing product of the same name (a unique
 * violation, which used to surface as an uncoded 500). A product with variants is refused (skipped,
 * with a reason) or archived, and a unique violation that still gets through answers a coded 409.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ProductsService } from "./products.service";
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
import { API_ERROR_CODES } from "../common/api-error-codes";

type Row = {
  id: string;
  name: string;
  isActive: boolean;
  parentProductId: string | null;
};

const row = (id: string, parentProductId: string | null = null, isActive = true): Row => ({
  id,
  name: `Product ${id}`,
  isActive,
  parentProductId,
});

describe("ProductsService.bulkDelete / clearAll: a product with variants (B1212)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let catalog: Row[];
  /** product ids that carry an invoice line (a historical reference: soft-delete, never hard-delete). */
  let referenced: Set<string>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    catalog = [];
    referenced = new Set();
    prisma.product.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: string[] }; parentProductId?: { in?: string[] } } }) => {
        const w = args?.where ?? {};
        if (w.id?.in) return catalog.filter((p) => w.id!.in!.includes(p.id));
        if (w.parentProductId?.in) {
          return catalog.filter(
            (p) => p.parentProductId && w.parentProductId!.in!.includes(p.parentProductId),
          );
        }
        return catalog;
      },
    );
    prisma.invoiceItem.groupBy.mockImplementation(
      async (args: { where?: { productId?: { in?: string[] } } }) =>
        [...referenced]
          .filter((id) => args?.where?.productId?.in?.includes(id))
          .map((productId) => ({ productId })),
    );
    // bulkDelete hands $transaction an array of already-started deleteMany promises.
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prisma),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: { presignedUrl: jest.fn(), presignedUrls: jest.fn(), upload: jest.fn() },
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
  });

  /** Ids passed to the one hard `product.deleteMany`, or [] when none ran. */
  const hardDeletedIds = (): string[] =>
    prisma.product.deleteMany.mock.calls.flatMap(
      (c: Array<{ where: { id: { in: string[] } } }>) => c[0].where.id.in,
    );
  const softDeletedIds = (): string[] =>
    prisma.product.updateMany.mock.calls.flatMap(
      (c: Array<{ where: { id: { in: string[] } } }>) => c[0].where.id.in,
    );

  it("a family with a variant outside the selection is skipped with a reason and NOT deleted", async () => {
    catalog = [row("fam"), row("v1", "fam")];
    const result = await service.bulkDelete(["fam"]);
    expect(hardDeletedIds()).not.toContain("fam");
    expect(softDeletedIds()).not.toContain("fam");
    expect(result.deleted).toBe(0);
    expect(result.skipped).toEqual([
      {
        id: "fam",
        code: "FAMILY_HAS_ACTIVE_VARIANTS",
        reason: expect.stringMatching(/variant/i),
      },
    ]);
  });

  it("a family with only ARCHIVED variants outside the selection is archived, never hard-deleted", async () => {
    catalog = [row("fam"), row("v1", "fam", false)];
    const result = await service.bulkDelete(["fam"]);
    expect(hardDeletedIds()).not.toContain("fam");
    expect(softDeletedIds()).toEqual(["fam"]);
    expect(result).toMatchObject({ deleted: 0, softDeleted: 1, skipped: [] });
  });

  it("a family and ALL its reference-free variants selected together are deleted together", async () => {
    catalog = [row("fam"), row("v1", "fam"), row("v2", "fam")];
    const result = await service.bulkDelete(["fam", "v1", "v2"]);
    expect(hardDeletedIds().sort()).toEqual(["fam", "v1", "v2"]);
    expect(result).toMatchObject({ deleted: 3, softDeleted: 0, skipped: [] });
  });

  it("a family whose selected variant can only be archived is archived too (never hard-deleted)", async () => {
    catalog = [row("fam"), row("v1", "fam"), row("v2", "fam")];
    referenced.add("v1"); // v1 has an invoice line, so it is archived rather than deleted
    const result = await service.bulkDelete(["fam", "v1", "v2"]);
    expect(hardDeletedIds()).toEqual(["v2"]);
    expect(softDeletedIds().sort()).toEqual(["fam", "v1"]);
    expect(result).toMatchObject({ deleted: 1, softDeleted: 2, skipped: [] });
  });

  it("a family selected with a variant that is skipped (active order lines) is skipped as well", async () => {
    catalog = [row("fam"), row("v1", "fam")];
    prisma.orderItem.groupBy.mockResolvedValue([{ productId: "v1" }]);
    const result = await service.bulkDelete(["fam", "v1"]);
    expect(hardDeletedIds()).toEqual([]);
    expect(softDeletedIds()).toEqual([]);
    expect(result.deleted + result.softDeleted).toBe(0);
    expect(result.skipped.map((s) => s.id).sort()).toEqual(["fam", "v1"]);
    expect(result.skipped.find((s) => s.id === "v1")?.code).toBe("PRODUCT_HAS_ACTIVE_ORDER_ITEMS");
    expect(result.skipped.find((s) => s.id === "fam")?.code).toBe("FAMILY_HAS_ACTIVE_VARIANTS");
  });

  it("clearAll over a family and its variants never hard-deletes a family that keeps a variant", async () => {
    catalog = [row("fam"), row("v1", "fam"), row("lone")];
    referenced.add("v1");
    const result = await service.clearAll();
    expect(hardDeletedIds()).toEqual(["lone"]);
    expect(softDeletedIds().sort()).toEqual(["fam", "v1"]);
    expect(result).toMatchObject({ deleted: 1, softDeleted: 2, skipped: [] });
  });

  it("a unique violation during the hard delete is a coded 409, not a raw 500", async () => {
    catalog = [row("lone")];
    prisma.product.deleteMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["tenantId", "name"] },
      }),
    );
    const err = await service.bulkDelete(["lone"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.PRODUCT_DELETE_CONFLICT,
    });
  });

  it("any other error from the hard delete is rethrown unchanged", async () => {
    catalog = [row("lone")];
    const boom = new Error("connection lost");
    prisma.product.deleteMany.mockRejectedValue(boom);
    await expect(service.bulkDelete(["lone"])).rejects.toBe(boom);
  });
});
