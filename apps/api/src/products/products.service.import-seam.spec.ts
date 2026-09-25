/**
 * B858 — the ProductsService surface the CSV importer depends on:
 *   R1: create() writes reorderPoint/reorderQty in its ONE create write (a first import used to
 *       plan them and store NULL, so every re-import planned null → n forever).
 *   W3: assertIdentityAvailable() is the read-only half of create()/update() — the importer's
 *       preview calls it — and throws exactly what those writes throw.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ProductsService — importer seam (B858)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrls: jest.fn().mockResolvedValue([]) } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.create.mockResolvedValue({ id: "prod-new" });
  });

  it("R1: create() stores reorderPoint and reorderQty in the one create write", async () => {
    await service.create(
      {
        name: "Widget",
        sku: "W-1",
        unit: "case",
        pricePerUnit: "10",
        reorderPoint: 4,
        reorderQty: 48,
      },
      { suppressEmit: true },
    );

    expect(prisma.product.create).toHaveBeenCalledTimes(1);
    expect(prisma.product.create.mock.calls[0][0].data).toMatchObject({
      reorderPoint: 4,
      reorderQty: 48,
    });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("R1: create() without reorder values leaves them unset (never 0)", async () => {
    await service.create({ name: "Widget", sku: "W-1", unit: "case", pricePerUnit: "10" });

    const data = prisma.product.create.mock.calls[0][0].data;
    expect(data.reorderPoint).toBeUndefined();
    expect(data.reorderQty).toBeUndefined();
  });

  it("W3: a standalone name already taken throws the create() conflict", async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: "prod-other" });

    await expect(
      service.assertIdentityAvailable({ name: "Widget", parentProductId: null }),
    ).rejects.toThrow(new ConflictException('A product named "Widget" already exists'));
    expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
      name: { equals: "Widget", mode: "insensitive" },
      parentProductId: null,
    });
  });

  it("W3: a sku colliding with another product's unit code throws, excluding the product itself", async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: "prod-other" });

    await expect(service.assertIdentityAvailable({ sku: "W-1" }, "prod-self")).rejects.toThrow(
      new BadRequestException("SKU already exists"),
    );
    expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
      OR: [{ sku: "W-1" }, { unitSku: "W-1" }],
      id: { not: "prod-self" },
    });
  });

  it("W3: nothing to check asks nothing and writes nothing", async () => {
    await service.assertIdentityAvailable({});

    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("W3: create() still refuses a taken name through the shared check", async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: "prod-other" });

    await expect(
      service.create({ name: "Widget", sku: "W-1", unit: "case", pricePerUnit: "10" }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it("R1: update() writes reorderPoint and reorderQty from its DTO", async () => {
    prisma.product.findUnique.mockResolvedValue({
      id: "prod-1",
      name: "Widget",
      sku: "W-1",
      parentProductId: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      imageKeys: [],
    });
    prisma.product.update.mockResolvedValue({ id: "prod-1" });

    await service.update("prod-1", { reorderPoint: 4, reorderQty: 48 }, { suppressEmit: true });

    const writes = prisma.product.update.mock.calls.map((c: any) => c[0].data);
    expect(writes).toContainEqual(expect.objectContaining({ reorderPoint: 4, reorderQty: 48 }));
  });
});
