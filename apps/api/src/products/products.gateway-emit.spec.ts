/**
 * REG-PROD-EMIT — every catalog write announces itself on the socket.
 *
 * The catalog was the one high-traffic surface with no server→client event: a
 * price edit, an archive, or a bulk MSRP change was invisible to an operator
 * phone whose scan/picker/list caches were already populated, so a scan kept
 * resolving the OLD price (or an archived product) for the whole staleTime.
 * Nine other domains already emit; products emitted nothing.
 *
 * These pin (a) that the three single-row write paths each emit exactly once
 * with the right action, (b) that the bulk paths emit ONE coalesced event rather
 * than one per row — a 500-id batch must not fan out 500 events to every phone —
 * and (c) that pure reads stay silent.
 */
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

const MOCK_PRODUCT = {
  id: "prod-1",
  name: "Cherry Tomatoes",
  sku: "TOM-001",
  unit: "punnet",
  pricePerUnit: 4.99,
  unitsPerBox: null,
  isActive: true,
  imageKeys: [] as string[],
};

describe("ProductsService — product.updated emits (REG-PROD-EMIT)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: { emitProductUpdated: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    gateway = { emitProductUpdated: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
        { provide: RouteFlowGateway, useValue: gateway },
      ],
    }).compile();

    service = mod.get(ProductsService);
  });

  it("REG-PROD-EMIT-1 create() emits once with the created id and action 'created'", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.create.mockResolvedValue({ ...MOCK_PRODUCT, id: "prod-new" });

    await service.create({
      name: "Cherry Tomatoes",
      sku: "TOM-001",
      unit: "punnet",
      pricePerUnit: 4.99,
    } as any);

    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitProductUpdated).toHaveBeenCalledWith("test-tenant", {
      productId: "prod-new",
      action: "created",
    });
  });

  it("REG-PROD-EMIT-2 update() — the only price/isActive write path — emits once as 'updated'", async () => {
    prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT as any);
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.update.mockResolvedValue({ ...MOCK_PRODUCT, pricePerUnit: 9.99 } as any);

    await service.update("prod-1", { pricePerUnit: 9.99 } as any);

    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitProductUpdated).toHaveBeenCalledWith("test-tenant", {
      productId: "prod-1",
      action: "updated",
    });
  });

  it("REG-PROD-EMIT-3 remove() (soft archive) emits once as 'archived'", async () => {
    prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT as any);
    prisma.orderItem.count.mockResolvedValue(0);
    prisma.product.update.mockResolvedValue({ ...MOCK_PRODUCT, isActive: false } as any);

    await service.remove("prod-1");

    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitProductUpdated).toHaveBeenCalledWith("test-tenant", {
      productId: "prod-1",
      action: "archived",
    });
  });

  it("REG-PROD-EMIT-4 bulkSetMsrp() over three rows emits ONE coalesced 'bulk' event", async () => {
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: null },
      { id: "p2", pricePerUnit: 10, unitsPerBox: null },
      { id: "p3", pricePerUnit: 10, unitsPerBox: null },
    ] as any);
    const txProduct = { update: jest.fn().mockResolvedValue({}) };
    prisma.tenantTransaction.mockImplementation((fn: any) => fn({ product: txProduct }));

    await service.bulkSetMsrp({
      items: [
        { productId: "p1", msrp: 20 },
        { productId: "p2", msrp: 20 },
        { productId: "p3", msrp: 20 },
      ],
    } as any);

    expect(txProduct.update).toHaveBeenCalledTimes(3);
    // One event for the batch, never one per row — a 500-id batch must not fan
    // out 500 invalidations to every operator phone.
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitProductUpdated).toHaveBeenCalledWith("test-tenant", {
      productId: null,
      action: "bulk",
    });
  });

  it("REG-PROD-EMIT-5 bulkDelete() emits ONE coalesced 'bulk' event, and clearAll() (which delegates) does not double it", async () => {
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
    ] as any);
    prisma.orderItem.groupBy.mockResolvedValue([] as any);
    for (const model of [
      "invoiceItem",
      "stockMovement",
      "vendorBillItem",
      "purchaseOrderItem",
      "estimateItem",
      "returnItem",
      "recurringInvoiceItem",
      "orderTemplateItem",
      "deliveryMutation",
      "stockLot",
    ]) {
      (prisma as any)[model].groupBy.mockResolvedValue([]);
    }
    prisma.$transaction.mockResolvedValue([] as any);

    await service.bulkDelete(["p1", "p2"]);
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);

    gateway.emitProductUpdated.mockClear();
    // clearAll() delegates straight to bulkDelete — exactly one event, not two.
    await service.clearAll();
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
  });

  it("REG-PROD-EMIT-6 bulkDelete() with nothing to delete emits nothing", async () => {
    await service.bulkDelete([]);
    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });

  it("REG-PROD-EMIT-7 pure reads never emit", async () => {
    prisma.product.findMany.mockResolvedValue([] as any);
    prisma.product.count.mockResolvedValue(0);
    await service.findAll({ page: 1, limit: 20 } as any);

    prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT as any);
    await service.findOne("prod-1");

    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });

  it("REG-PROD-EMIT-8 bulkAssignParent() over two assignments emits ONE coalesced 'bulk' event, not one per update()", async () => {
    prisma.product.findFirst
      .mockResolvedValueOnce({ id: "parent-1", parentProductId: null } as any) // parent lookup
      .mockResolvedValue(null); // per-row name-uniqueness checks inside update()
    prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT as any);
    prisma.product.update.mockResolvedValue({ ...MOCK_PRODUCT } as any);

    const result = await service.bulkAssignParent({
      parentProductId: "parent-1",
      assignments: [
        { id: "p1", variantName: "Small" },
        { id: "p2", variantName: "Large" },
      ],
    } as any);

    expect(result.succeeded).toEqual(["p1", "p2"]);
    expect(prisma.product.update).toHaveBeenCalledTimes(2);
    // The per-row update() calls ran with suppressEmit — only the coalesced
    // post-loop emit fires. Regressing to "emit per row" would fail this at 2.
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitProductUpdated).toHaveBeenCalledWith("test-tenant", {
      productId: null,
      action: "bulk",
    });
  });

  it("REG-PROD-EMIT-9 bulkAssignParent() with every assignment failing emits NOTHING", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "parent-1", parentProductId: null } as any);
    prisma.product.findUnique.mockRejectedValue(new Error("not found"));

    const result = await service.bulkAssignParent({
      parentProductId: "parent-1",
      assignments: [{ id: "p1", variantName: "Small" }],
    } as any);

    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });

  it("REG-PROD-EMIT-10 importFromZoho() over multiple created rows emits ONE coalesced 'bulk' event, never one per row", async () => {
    prisma.product.findFirst.mockResolvedValue(null); // no name/sku/barcode collisions
    prisma.product.create.mockResolvedValue({} as any);

    const result = await service.importFromZoho({
      items: [
        { name: "Item A", unit: "each", pricePerUnit: 1 },
        { name: "Item B", unit: "each", pricePerUnit: 2 },
        { name: "Item C", unit: "each", pricePerUnit: 3 },
      ],
    } as any);

    expect(result.created).toBe(3);
    expect(prisma.product.create).toHaveBeenCalledTimes(3);
    // A 3-row (or 500-row) import must produce ONE invalidation, not one per row.
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitProductUpdated).toHaveBeenCalledWith("test-tenant", {
      productId: null,
      action: "bulk",
    });
  });

  it("REG-PROD-EMIT-11 importFromZoho() creating nothing (all skipped) emits nothing", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "existing" } as any); // every name collides

    const result = await service.importFromZoho({
      items: [{ name: "Item A", unit: "each", pricePerUnit: 1 }],
    } as any);

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });

  it("REG-PROD-EMIT-12 emitProductChanged swallows a gateway throw — a socket failure never fails a committed catalog write", async () => {
    prisma.product.findUnique.mockResolvedValue(MOCK_PRODUCT as any);
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.update.mockResolvedValue({ ...MOCK_PRODUCT, pricePerUnit: 9.99 } as any);
    gateway.emitProductUpdated.mockImplementation(() => {
      throw new Error("socket unavailable");
    });

    // Without the try/catch inside emitProductChanged, this throw would
    // propagate out of update() and turn an already-committed Prisma write
    // into a 500 for the caller.
    await expect(service.update("prod-1", { pricePerUnit: 9.99 } as any)).resolves.toEqual({
      ...MOCK_PRODUCT,
      pricePerUnit: 9.99,
    });
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
  });
});
