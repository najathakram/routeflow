/**
 * H2: reparenting a variant never silently drops a label (a legal selling ban). Every `parentProductId` change
 * (PATCH /products/:id, an unlink, and the bulk "group as variants" move, which runs through update()) calls
 * `keepLabelsOnReparent` INSIDE the update transaction, after the parent write, and reports what it kept.
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

jest.mock("../product-labels/keep-labels-on-reparent", () => ({
  keepLabelsOnReparent: jest.fn(),
  effectiveCategoryIdsUnder: jest.fn(),
}));
import { keepLabelsOnReparent } from "../product-labels/keep-labels-on-reparent";

const TENANT = "t-1";
const keep = keepLabelsOnReparent as jest.Mock;

describe("ProductsService: a reparent keeps the labels the variant carried (H2)", () => {
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

  const FAMILY = { id: "fam", isActive: true, kind: "FAMILY", parentProductId: null };

  function seedVariant(parentId: string | null) {
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
    prisma.product.update.mockResolvedValue({ ...PRODUCT, parentProductId: "fam" });
    prisma.recipe.findFirst.mockResolvedValue(null);
    prisma.recipe.findMany.mockResolvedValue([]);
  }

  beforeEach(() => {
    keep.mockReset();
    keep.mockResolvedValue({ keptLabels: [] });
  });

  it("a parent change calls the keep AFTER the parent write, in the same tx, and reports keptLabels", async () => {
    seedVariant("old");
    keep.mockResolvedValue({ keptLabels: ["CA ban"] });
    let txSeen: unknown;
    const order: string[] = [];
    prisma.product.update.mockImplementation(async () => {
      order.push("update");
      return { ...PRODUCT, parentProductId: "fam" };
    });
    keep.mockImplementation(async (tx: unknown) => {
      txSeen = tx;
      order.push("keep");
      return { keptLabels: ["CA ban"] };
    });
    const out = await service.update("prod-1", { parentProductId: "fam" } as never, {
      actorId: "u1",
      actorName: "Ann",
    });
    expect(order).toEqual(["update", "keep"]);
    expect(keep).toHaveBeenCalledWith(
      txSeen,
      expect.objectContaining({
        tenantId: TENANT,
        productId: "prod-1",
        fromParentId: "old",
        toParentId: "fam",
        actor: { id: "u1", name: "Ann" },
      }),
    );
    expect(txSeen).toBeDefined();
    expect((out as { keptLabels?: string[] }).keptLabels).toEqual(["CA ban"]);
  });

  it("an unlink (parentProductId: null) keeps too, with no new parent", async () => {
    seedVariant("fam");
    prisma.product.update.mockResolvedValue({ ...PRODUCT, parentProductId: null });
    keep.mockResolvedValue({ keptLabels: ["NY ban"] });
    const out = await service.update("prod-1", { parentProductId: null } as never);
    expect(keep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromParentId: "fam", toParentId: null }),
    );
    expect((out as { keptLabels?: string[] }).keptLabels).toEqual(["NY ban"]);
  });

  it("controls: no parent change (an echo of the current parent, or no parent field) never runs the keep", async () => {
    seedVariant("fam");
    prisma.product.findFirst.mockImplementation(async (args: { where?: { id?: string } }) =>
      args?.where?.id === "prod-1"
        ? { parentProductId: "fam", unitsPerBox: null }
        : args?.where?.id === "fam"
          ? FAMILY
          : null,
    );
    const echo = await service.update("prod-1", {
      parentProductId: "fam",
      description: "x",
    } as never);
    await service.update("prod-1", { description: "y" } as never);
    expect(keep).not.toHaveBeenCalled();
    expect(echo).not.toHaveProperty("keptLabels");
  });

  it("atomic: a failing keep rejects the whole update (it ran inside the tx callback) and nothing is emitted", async () => {
    seedVariant("old");
    keep.mockRejectedValue(new Error("materialise failed"));
    const emit = jest.spyOn(service as never, "emitProductChanged" as never);
    await expect(service.update("prod-1", { parentProductId: "fam" } as never)).rejects.toThrow(
      "materialise failed",
    );
    expect(prisma.tenantTransaction).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("an unlink keeps the variant's name and variantName: neither is written", async () => {
    seedVariant("fam");
    prisma.product.update.mockResolvedValue({ ...PRODUCT, parentProductId: null });
    await service.update("prod-1", { parentProductId: null } as never);
    const data = prisma.product.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ parentProductId: null, kind: "STANDARD" });
    expect(data).not.toHaveProperty("variantName");
    expect(data).not.toHaveProperty("name");
  });

  it("atomic: the parent write and the label keep share ONE tx; a throw in the keep leaves the write uncommitted", async () => {
    seedVariant("old");
    const txs: unknown[] = [];
    let committed = false;
    (prisma.tenantTransaction as jest.Mock).mockImplementation(
      async (fn: (t: unknown) => unknown) => {
        const tx = prisma; // the mock's tx object
        txs.push(tx);
        const out = await fn(tx); // a rejection here skips the commit below
        committed = true;
        return out;
      },
    );
    prisma.product.update.mockImplementation(async function (this: unknown) {
      txs.push("write-in-tx-" + txs.length);
      return { ...PRODUCT, parentProductId: "fam" };
    });
    keep.mockImplementation(async (tx: unknown) => {
      expect(tx).toBe(txs[0]); // the keep got the very tx the update ran in
      throw new Error("materialise failed");
    });
    await expect(service.update("prod-1", { parentProductId: "fam" } as never)).rejects.toThrow(
      "materialise failed",
    );
    expect(prisma.product.update).toHaveBeenCalledTimes(1);
    expect(committed).toBe(false);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("bulkAssignParent reports what was kept PER child (nothing for a child that lost nothing)", async () => {
    seedVariant(null);
    const update = jest
      .spyOn(service, "update")
      .mockResolvedValueOnce({ id: "a", keptLabels: ["CA ban", "NY ban"] } as never)
      .mockResolvedValueOnce({ id: "b" } as never)
      .mockResolvedValueOnce({ id: "c", keptLabels: ["CA ban"] } as never);
    const result = await service.bulkAssignParent({
      parentProductId: "fam",
      assignments: [
        { id: "a", variantName: "A" },
        { id: "b", variantName: "B" },
        { id: "c", variantName: "C" },
      ],
    } as never);
    expect(update).toHaveBeenCalledTimes(3);
    expect(result.succeeded).toEqual(["a", "b", "c"]);
    expect(result.keptLabels).toEqual([
      { id: "a", labels: ["CA ban", "NY ban"] },
      { id: "c", labels: ["CA ban"] },
    ]);
  });

  it("bulkAssignParent: a child whose keep fails is reported failed and keeps nothing; the rest go on", async () => {
    seedVariant(null);
    jest
      .spyOn(service, "update")
      .mockRejectedValueOnce(new Error("raw prisma text"))
      .mockResolvedValueOnce({ id: "b", keptLabels: ["CA ban"] } as never);
    const result = await service.bulkAssignParent({
      parentProductId: "fam",
      assignments: [
        { id: "a", variantName: "A" },
        { id: "b", variantName: "B" },
      ],
    } as never);
    expect(result.failed).toEqual([{ id: "a", reason: "Update failed" }]);
    expect(result.keptLabels).toEqual([{ id: "b", labels: ["CA ban"] }]);
  });
});
