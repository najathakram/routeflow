/**
 * SA-823 R11 (PR-1): every change of a product's parent writes ONE `product.family_assigned` audit row, with
 * `tx.auditLog.create` INSIDE update()'s transaction, so it rolls back with the reparent. The door is named by `via`
 * (editor / bulk_assign / import / inventory); an echo of the same parent writes nothing; an unlink writes a row with
 * toParentId null. The existing entries are `assignToParent` / `unlinkFromParent` (REQUIRED `via`); update() itself
 * takes an optional `reparentVia` and throws a plain Error when the parent changes without it.
 */
import { Test, TestingModule } from "@nestjs/testing";
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
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

jest.mock("../product-labels/keep-labels-on-reparent", () => ({
  ...jest.requireActual("../product-labels/keep-labels-on-reparent"),
  keepLabelsOnReparent: jest.fn(),
  effectiveCategoryIdsUnder: jest.fn(),
  planReparentLabels: jest.fn(),
}));
import {
  keepLabelsOnReparent,
  planReparentLabels,
} from "../product-labels/keep-labels-on-reparent";

const TENANT = "t-1";
const keep = keepLabelsOnReparent as jest.Mock;
const plan = planReparentLabels as jest.Mock;

describe("ProductsService: a parent change writes one product.family_assigned row (SA-823 R11)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  /** The transaction object handed to the tx callback: DISTINCT from `prisma`, so a write on `this.prisma` is visible. */
  let tx: any;
  let committed: boolean;

  const PRODUCT = {
    id: "prod-1",
    name: "Mint",
    variantName: "Mint",
    sku: "TOM-001",
    unit: "each",
    pricePerUnit: 4.99,
    category: "Produce",
    isActive: true,
    kind: "STANDARD",
    parentProductId: null as string | null,
    currentStock: 7,
    imageKeys: [] as string[],
    variants: [],
    barcodes: [],
    images: [],
  };
  const FAMILY = { id: "fam", isActive: true, kind: "FAMILY", parentProductId: null };

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
    keep.mockReset();
    keep.mockResolvedValue({ keptLabels: [] });
    plan.mockReset();
    plan.mockResolvedValue([]);
    committed = false;
    tx = Object.create(prisma);
    tx.auditLog = { create: jest.fn().mockResolvedValue({}) };
    (prisma.tenantTransaction as jest.Mock).mockImplementation(
      async (fn: (t: unknown) => unknown) => {
        const out = await fn(tx);
        committed = true;
        return out;
      },
    );
  });

  function seed(parentId: string | null, toId: string | null = "fam") {
    prisma.product.findUnique.mockResolvedValue({
      ...PRODUCT,
      parentProductId: parentId,
      kind: parentId ? "VARIANT" : "STANDARD",
    });
    prisma.product.findFirst.mockImplementation(async (args: { where?: { id?: string } }) => {
      const id = args?.where?.id;
      if (id === "prod-1")
        return { parentProductId: parentId, unitsPerBox: null, category: "Produce" };
      return id === "fam" ? FAMILY : null;
    });
    prisma.product.count.mockResolvedValue(0);
    prisma.product.update.mockResolvedValue({
      ...PRODUCT,
      parentProductId: toId,
      kind: toId ? "VARIANT" : "STANDARD",
    });
    prisma.recipe.findFirst.mockResolvedValue(null);
    prisma.recipe.findMany.mockResolvedValue([]);
  }

  const rows = () => tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
  const familyRows = () =>
    rows().filter((d: { action: string }) => d.action === AUDIT_ACTIONS.PRODUCT_FAMILY_ASSIGNED);

  it("T1: an editor PATCH that moves a product to a family writes one product.family_assigned row {from, to, variantName, via: editor} in the update's transaction", async () => {
    seed(null);
    await service.update("prod-1", { parentProductId: "fam" } as never, {
      packPrecondition: "client",
      reparentVia: "editor",
      actorId: "u1",
    });
    expect(familyRows()).toEqual([
      {
        tenantId: TENANT,
        userId: "u1",
        action: "product.family_assigned",
        entityType: "Product",
        entityId: "prod-1",
        meta: {
          productId: "prod-1",
          fromParentId: null,
          toParentId: "fam",
          variantName: "Mint",
          via: "editor",
        },
      },
    ]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled(); // never on this.prisma
  });

  it("T2: bulk assign writes one product.family_assigned row per moved product with via bulk_assign, through assignToParent", async () => {
    seed(null);
    const viaEntry = jest.spyOn(service, "assignToParent");
    const out = await service.bulkAssignParent(
      {
        parentProductId: "fam",
        assignments: [{ id: "prod-1", variantName: "Mint" }],
      } as never,
      { actorId: "u2", actorName: "Ann" },
    );
    expect(out.succeeded).toEqual(["prod-1"]);
    expect(viaEntry).toHaveBeenCalledWith("prod-1", "fam", "Mint", {
      via: "bulk_assign",
      suppressEmit: true,
      actorId: "u2",
      actorName: "Ann",
    });
    expect(familyRows()).toHaveLength(1);
    expect(familyRows()[0]).toMatchObject({
      userId: "u2",
      meta: { productId: "prod-1", toParentId: "fam", via: "bulk_assign" },
    });
  });

  it("T3: unlinking (parentProductId null) writes a row with toParentId null; re-saving the same parent writes none", async () => {
    seed("fam", null);
    await service.unlinkFromParent("prod-1", { via: "editor", actorId: "u1" });
    expect(familyRows()).toHaveLength(1);
    expect(familyRows()[0].meta).toMatchObject({
      fromParentId: "fam",
      toParentId: null,
      via: "editor",
    });

    tx.auditLog.create.mockClear();
    seed("fam", "fam");
    await service.update("prod-1", { parentProductId: "fam", description: "x" } as never, {
      packPrecondition: "internal",
    });
    expect(familyRows()).toHaveLength(0);
  });

  it("T4: the row is written on the update's tx; a forced failure leaves the commit unreached, so neither the parent change nor the row persists", async () => {
    seed(null);
    tx.auditLog.create.mockRejectedValue(new Error("audit write failed"));
    await expect(
      service.update("prod-1", { parentProductId: "fam" } as never, {
        packPrecondition: "internal",
        reparentVia: "editor",
      }),
    ).rejects.toThrow("audit write failed");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(committed).toBe(false); // the parent write and the row share ONE rolled-back transaction
  });

  it("T6: assignToParent into a FAMILY makes the product a VARIANT named by its label; stock and the five price columns are unchanged; no productUnit or stockMovement write", async () => {
    seed(null);
    await service.assignToParent("prod-1", "fam", "Mint", { via: "bulk_assign" });
    const data = prisma.product.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ parentProductId: "fam", kind: "VARIANT", variantName: "Mint" });
    for (const col of [
      "currentStock",
      "pricePerUnit",
      "priceTier2",
      "priceTier3",
      "priceTier4",
      "priceTier5",
    ]) {
      expect(data).not.toHaveProperty(col);
    }
    for (const m of ["create", "createMany", "update", "updateMany", "upsert", "delete"]) {
      expect((prisma.productUnit as any)[m]).not.toHaveBeenCalled();
      expect((prisma.stockMovement as any)[m]).not.toHaveBeenCalled();
    }
  });

  it("T16: update() throws a plain Error when parentProductId changes without reparentVia, and writes no row", async () => {
    seed(null);
    const err = await service
      .update("prod-1", { parentProductId: "fam" } as never, { packPrecondition: "internal" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toHaveProperty("getStatus");
    expect((err as Error).message).toMatch(/reparentVia/);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(committed).toBe(false);
  });

  it("T16 twin: create() under a parent without reparentVia throws a plain Error and writes nothing", async () => {
    const err = await service
      .create({
        name: "Grape",
        variantName: "Grape",
        parentProductId: "fam",
        unit: "each",
        pricePerUnit: "1",
      } as never)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toHaveProperty("getStatus");
    expect((err as Error).message).toMatch(/reparentVia/);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("create() under a parent writes the row in its own create transaction with fromParentId null (via from the caller)", async () => {
    const PARENT = {
      isActive: true,
      kind: "FAMILY",
      parentProductId: null,
      pricePerUnit: 1,
      priceTier2: 1,
      priceTier3: 1,
      priceTier4: 1,
      priceTier5: 1,
      category: null,
      unitsPerBox: 1,
      costingMethod: "AVCO",
      standardCost: 1,
      isTobacco: false,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      regItemType: null,
      regUomCase: null,
      regUomUnit: null,
    };
    prisma.product.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.id === "fam" ? PARENT : null),
    );
    prisma.product.create.mockResolvedValue({
      ...PRODUCT,
      id: "new-v",
      variantName: "Grape",
      parentProductId: "fam",
      category: null,
    });
    await service.create(
      {
        name: "Grape",
        variantName: "Grape",
        parentProductId: "fam",
        unit: "each",
        pricePerUnit: "1",
      } as never,
      { reparentVia: "import", actorId: "u3" },
    );
    expect(familyRows()).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        userId: "u3",
        entityId: "new-v",
        meta: {
          productId: "new-v",
          fromParentId: null,
          toParentId: "fam",
          variantName: "Grape",
          via: "import",
        },
      }),
    ]);
  });

  it("control: an update that does not touch the parent needs no reparentVia and writes no row", async () => {
    seed("fam", "fam");
    await service.update("prod-1", { description: "y" } as never, {
      packPrecondition: "internal",
    });
    expect(familyRows()).toHaveLength(0);
  });
});
