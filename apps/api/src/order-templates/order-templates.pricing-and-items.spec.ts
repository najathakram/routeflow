import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B48: a standing-order line was priced with the raw catalog price
 * (`Number(product.pricePerUnit)`), never the shared buyer-pricing resolver —
 * so a template order ignored the customer's pricing tier, per-product
 * CustomerPrice overrides, active promotions (including BUY_N_GET_M), the
 * sticky-upsell price memory, and boxed selling-unit semantics that every
 * interactive order already applies via `OrdersService.resolveBuyerLinePrice`
 * + `computeLineSubtotal`. These specs run the REAL resolver (the prototype
 * method takes no `this`) and the REAL `computeLineSubtotal`, mocking only
 * the database and the promotion/history loaders, so the money assertions are
 * arithmetic, not mirrors of a mock — test-plan.md §2.1 "T9 — harness".
 *
 * T25/T26 (B09, R20/R21): `update()`'s PATCH item-replacement path — an atomic,
 * product-validated, tenantId-stamped swap.
 */
describe("OrderTemplatesService — pricing via the shared resolver, PATCH item replacement", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ordersService: {
    mergeAllPendingForCustomer: jest.Mock;
    loadActivePromotions: jest.Mock;
    getCustomerPriceHistory: jest.Mock;
    resolveBuyerLinePrice: jest.Mock;
  };
  let authGuard: { checkAuthorized: jest.Mock };
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };

  // The prototype method takes no `this` (test-plan.md §2.1), so calling it
  // unbound reproduces the exact production pricing ladder.
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ordersService = {
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      loadActivePromotions: jest.fn().mockResolvedValue([]),
      getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
      resolveBuyerLinePrice: jest.fn((...args: any[]) => realResolver(...args)),
    };
    authGuard = { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) };
    notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(1),
      sendToUser: jest.fn().mockResolvedValue(1),
    };

    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        // settings.taxRate is stored as a PERCENT string — "10" is 10%.
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
  });

  function setTemplate(items: Array<{ productId: string; qty: number; notes?: string | null }>) {
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items,
    });
  }

  function createdLine(index = 0) {
    return prisma.order.create.mock.calls[0][0].data.lineItems.create[index];
  }

  it("REG-B48 prices a template line via the tier ladder (tier 2 -> priceTier2) and computes the subtotal (T9)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 2 });
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        pricePerUnit: 10,
        priceTier2: 8,
        unitsPerBox: null,
        category: null,
        trackedCategoryId: null,
      },
    ]);
    setTemplate([{ productId: "p1", qty: 2, notes: null }]);

    await service.generateOrder("t1");

    const line = createdLine();
    expect(line.unitPrice).toBe(8);
    expect(line.priceType).toBe("SPECIAL");
    expect(line.originalPrice).toBe(10);
    expect(line.promoFreeUnits).toBeNull();
    expect(line.subtotal).toBe(16);

    const orderData = prisma.order.create.mock.calls[0][0].data;
    expect(orderData.subtotal).toBe(16);
    expect(orderData.tax).toBe(1.6);
    expect(orderData.total).toBe(17.6);
  });

  it("REG-B48 a per-product CustomerPrice override beats the customer's default tier (T10)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([{ productId: "p1", pricingTier: 3 }]);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        pricePerUnit: 10,
        priceTier3: 7,
        unitsPerBox: null,
        category: null,
        trackedCategoryId: null,
      },
    ]);
    setTemplate([{ productId: "p1", qty: 1, notes: null }]);

    await service.generateOrder("t1");

    const line = createdLine();
    expect(line.unitPrice).toBe(7);
    expect(line.priceType).toBe("SPECIAL");
    expect(line.originalPrice).toBe(10);
    expect(prisma.customerPrice.findMany).toHaveBeenCalledWith({
      where: { customerId: "c1", productId: { in: ["p1"] } },
    });
  });

  it("REG-B48 a null CustomerPrice override falls through to the customer's default tier (T11)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 2 });
    prisma.customerPrice.findMany.mockResolvedValue([{ productId: "p1", pricingTier: null }]);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        pricePerUnit: 10,
        priceTier2: 8,
        unitsPerBox: null,
        category: null,
        trackedCategoryId: null,
      },
    ]);
    setTemplate([{ productId: "p1", qty: 1, notes: null }]);

    await service.generateOrder("t1");

    expect(createdLine().unitPrice).toBe(8);
  });

  it("REG-B48 applies the best active promotion, loaded for the CUSTOMER role (T12)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    ordersService.loadActivePromotions.mockResolvedValue([
      {
        id: "promo-1",
        type: "PERCENT",
        value: 10,
        minQty: null,
        scope: "ALL",
        category: null,
        productIds: [],
      },
    ]);
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: null, category: null, trackedCategoryId: null },
    ]);
    setTemplate([{ productId: "p1", qty: 3, notes: null }]);

    await service.generateOrder("t1");

    const line = createdLine();
    expect(line.unitPrice).toBe(9);
    expect(line.priceType).toBe("PROMO");
    expect(line.originalPrice).toBe(10);
    expect(line.subtotal).toBe(27);
    expect(ordersService.loadActivePromotions).toHaveBeenCalledWith("CUSTOMER");
    expect(ordersService.loadActivePromotions).toHaveBeenCalledTimes(1);
  });

  it("REG-B48 a BUY_N_GET_M promotion reduces the subtotal by whole free units (T13)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    ordersService.loadActivePromotions.mockResolvedValue([
      { id: "bogo", type: "BUY_N_GET_M", value: 1, minQty: 2, scope: "ALL" },
    ]);
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: null, category: null, trackedCategoryId: null },
    ]);
    setTemplate([{ productId: "p1", qty: 3, notes: null }]);

    await service.generateOrder("t1");

    const line = createdLine();
    expect(line.unitPrice).toBe(10);
    expect(line.priceType).toBe("PROMO");
    expect(line.originalPrice).toBeNull();
    expect(line.promoFreeUnits).toBe(1);
    expect(line.subtotal).toBe(20);
    expect(prisma.order.create.mock.calls[0][0].data.subtotal).toBe(20);
  });

  it("REG-B48 a boxed product's template qty bills as whole boxes, no proration (T14)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 2 });
    const product = {
      id: "p1",
      pricePerUnit: 24,
      priceTier2: 20,
      unitsPerBox: 12,
      category: null,
      trackedCategoryId: null,
    };
    prisma.product.findMany.mockResolvedValue([product]);
    setTemplate([{ productId: "p1", qty: 2, notes: null }]);

    await service.generateOrder("t1");

    expect(ordersService.resolveBuyerLinePrice).toHaveBeenCalledWith(product, 2, [], 24, 2, null, {
      boxes: null,
      pieces: null,
      unitsPerBox: 12,
    });
    const line = createdLine();
    expect(line.unitPrice).toBe(20);
    expect(line.subtotal).toBe(40);
  });

  it("REG-B48 a remembered above-list price (sticky upsell) wins over the tier (T15)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    ordersService.getCustomerPriceHistory.mockResolvedValue({
      p1: { lastPrice: 12, listPriceAtTime: 10 },
    });
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: null, category: null, trackedCategoryId: null },
    ]);
    setTemplate([{ productId: "p1", qty: 1, notes: null }]);

    await service.generateOrder("t1");

    const line = createdLine();
    expect(line.unitPrice).toBe(12);
    expect(line.priceType).toBe("MANUAL");
    expect(line.originalPrice).toBe(10);
    expect(ordersService.getCustomerPriceHistory).toHaveBeenCalledWith("c1");
  });

  it("REG-B48 tier 1 with no override/promo/history still persists STANDARD and a null originalPrice (T16)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: null, category: null, trackedCategoryId: null },
    ]);
    setTemplate([{ productId: "p1", qty: 2, notes: null }]);

    await service.generateOrder("t1");

    const line = createdLine();
    expect(line.priceType).toBe("STANDARD");
    expect(line.originalPrice).toBeNull();
  });

  it("REG-B09 update() replaces items atomically in one transaction, deleteMany before the write (T25)", async () => {
    const calls: string[] = [];
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: [{ id: "old1", productId: "p1", qty: 1, notes: null }],
    });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    prisma.orderTemplateItem.deleteMany.mockImplementation(() => {
      calls.push("deleteMany");
      return Promise.resolve({ count: 1 });
    });
    prisma.orderTemplate.update.mockImplementation((a: any) => {
      calls.push("update");
      return Promise.resolve({ id: "t1", ...a.data });
    });

    await service.update("t1", {
      name: "n",
      items: [
        { productId: "p1", qty: 2 },
        { productId: "p2", qty: 1, notes: "n2" },
      ],
    } as any);

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["deleteMany", "update"]);
    expect(prisma.orderTemplateItem.deleteMany).toHaveBeenCalledWith({
      where: { templateId: "t1" },
    });
    const updateArg = prisma.orderTemplate.update.mock.calls[0][0];
    expect(updateArg.data.name).toBe("n");
    expect(updateArg.data.items.create).toEqual([
      { productId: "p1", qty: 2, notes: undefined, tenantId: "test-tenant" },
      { productId: "p2", qty: 1, notes: "n2", tenantId: "test-tenant" },
    ]);
  });

  it("REG-B09 update() validates every item's product exists before writing anything (T26)", async () => {
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: [],
    });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);

    await expect(
      service.update("t1", {
        items: [
          { productId: "p1", qty: 1 },
          { productId: "p-missing", qty: 1 },
        ],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.orderTemplateItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});
