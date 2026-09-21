import { Test } from "@nestjs/testing";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { decrementStockForSale } from "../orders/order-stock";

/**
 * B647 + B658: a standing order is written through a bare `prisma.order.create()`, never
 * `OrdersService.create()` — so it skipped BOTH the stock decrement (B647: a cancel then
 * credits back a decrement that never happened, inflating currentStock) and the regulated
 * per-category levy (B658: categoryTaxAmount hardcoded 0, silently under-collected).
 *
 * These specs use the REAL `resolveBuyerLinePrice` (prototype, no `this`), the REAL
 * `computeLineSubtotal`/`computeCategoryTax`, and the REAL `decrementStockForSale` — mocking
 * only the database, the promotion/history loaders, and (where noted) `../orders/order-stock`
 * to assert the exact call, so the money assertions are arithmetic, not mirrors of a stub.
 */
jest.mock("../orders/order-stock", () => ({
  decrementStockForSale: jest.fn().mockResolvedValue(undefined),
}));
const mockDecrementStockForSale = decrementStockForSale as jest.Mock;

describe("OrderTemplatesService — stock decrement + regulated levy on generated orders", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ordersService: {
    mergeAllPendingForCustomer: jest.Mock;
    loadActivePromotions: jest.Mock;
    getCustomerPriceHistory: jest.Mock;
    resolveBuyerLinePrice: jest.Mock;
  };
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockDecrementStockForSale.mockClear();
    ordersService = {
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      loadActivePromotions: jest.fn().mockResolvedValue([]),
      getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
      resolveBuyerLinePrice: jest.fn((...args: any[]) => realResolver(...args)),
    };

    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        // settings.taxRate is stored as a PERCENT string — "10" is 10%.
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendToCustomer: jest.fn().mockResolvedValue(1),
            sendToUser: jest.fn().mockResolvedValue(1),
          },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.trackedCategory.findMany.mockResolvedValue([]);
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

  // ─── B647: stock decrement ──────────────────────────────────────────────────

  describe("B647 — stock decrement", () => {
    it("decrements stock through the SAME shared decrementStockForSale helper create() uses", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([{ productId: "p1", qty: 3, notes: null }]);

      await service.generateOrder("t1");

      expect(mockDecrementStockForSale).toHaveBeenCalledTimes(1);
      const [deps, , stockLines, isStaffRole] = mockDecrementStockForSale.mock.calls[0];
      expect(deps).toEqual(expect.objectContaining({ tenantId: "test-tenant" }));
      expect(stockLines).toEqual([{ productId: "p1", qty: 3 }]);
      // An unattended cron run must never abort on insufficient stock — the staff/operator
      // posture (warn + oversell), never the customer/driver hard-block.
      expect(isStaffRole).toBe(true);
    });

    it("aggregates one stockLine per product across multiple template lines", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
        { id: "p2", pricePerUnit: 5, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([
        { productId: "p1", qty: 2, notes: null },
        { productId: "p2", qty: 4, notes: null },
      ]);

      await service.generateOrder("t1");

      const [, , stockLines] = mockDecrementStockForSale.mock.calls[0];
      expect(stockLines).toEqual([
        { productId: "p1", qty: 2 },
        { productId: "p2", qty: 4 },
      ]);
    });

    it("never decrements a line skipped by the regulated license guard", async () => {
      const authGuard = { checkAuthorized: jest.fn() };
      const mod = await Test.createTestingModule({
        providers: [
          OrderTemplatesService,
          { provide: PrismaService, useValue: prisma },
          { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
          { provide: OrdersService, useValue: ordersService },
          { provide: AuthorizationGuardService, useValue: authGuard },
          {
            provide: NotificationsService,
            useValue: {
              sendToCustomer: jest.fn().mockResolvedValue(1),
              sendToUser: jest.fn().mockResolvedValue(1),
            },
          },
        ],
      }).compile();
      const gatedService = mod.get(OrderTemplatesService);

      authGuard.checkAuthorized.mockResolvedValue({
        blocked: [{ trackedCategoryId: "cat-tob", categoryName: "Tobacco", reason: "NO_AUTH" }],
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "p-tob", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: "cat-tob" },
        { id: "p-std", pricePerUnit: 5, unitsPerBox: null, trackedCategoryId: null },
      ]);
      prisma.user.findMany.mockResolvedValue([]);
      setTemplate([
        { productId: "p-tob", qty: 2, notes: null },
        { productId: "p-std", qty: 3, notes: null },
      ]);

      await gatedService.generateOrder("t1");

      const [, , stockLines] = mockDecrementStockForSale.mock.calls[0];
      expect(stockLines).toEqual([{ productId: "p-std", qty: 3 }]);
    });
  });

  // ─── B658: regulated per-category levy ──────────────────────────────────────

  describe("B658 — regulated per-category levy", () => {
    it("folds a PERCENT_OF_SALE category levy into categoryTaxAmount and the order total", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: "cat-1" },
      ]);
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: 0.05, priceIncludesTax: false },
      ]);
      setTemplate([{ productId: "p1", qty: 2, notes: null }]);

      await service.generateOrder("t1");

      const createArg = prisma.order.create.mock.calls[0][0].data;
      const line = createArg.lineItems.create[0];
      // subtotal = 10 * 2 = 20; category levy = 20 * 0.05 = 1; regular tax = 20 * 0.10 = 2.
      expect(line.subtotal).toBe(20);
      expect(line.categoryTaxAmount).toBe(1);
      expect(createArg.subtotal).toBe(20);
      expect(createArg.tax).toBe(2);
      expect(createArg.total).toBe(23); // 20 + 2 (regular tax) + 1 (category levy)
    });

    it("folds an EXCISE_PER_UNIT category levy basis-priced on true PIECE qty, not selling units", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: 12, trackedCategoryId: "cat-1" },
      ]);
      prisma.trackedCategory.findMany.mockResolvedValue([
        { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: 0.5, priceIncludesTax: false },
      ]);
      // qty:2 boxes of 12 -> qtyPieces 24 for the levy basis (a template line is never split
      // into boxes/pieces — see the "box-unaware boxed line" comment in the service).
      setTemplate([{ productId: "p1", qty: 2, notes: null }]);

      await service.generateOrder("t1");

      const line = prisma.order.create.mock.calls[0][0].data.lineItems.create[0];
      expect(line.categoryTaxAmount).toBe(12); // 24 pieces * $0.50
    });

    it("charges no levy for a plain (non-regulated) line — categoryTaxAmount 0, total unchanged", async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
      ]);
      setTemplate([{ productId: "p1", qty: 1, notes: null }]);

      await service.generateOrder("t1");

      const createArg = prisma.order.create.mock.calls[0][0].data;
      expect(createArg.lineItems.create[0].categoryTaxAmount).toBe(0);
      expect(createArg.total).toBe(11); // 10 + 1 (10% regular tax) + 0
    });
  });
});
