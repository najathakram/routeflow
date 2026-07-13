import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module)
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
  })),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { OrderStatus, UserRole, Prisma } from "@prisma/client";

const MOCK_PRODUCT = {
  id: "prod-1",
  name: "Tomatoes",
  pricePerUnit: 4.99,
  unit: "punnet",
};

const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 14.97,
  tax: 1.5,
  total: 16.47,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Test Business" },
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const customerPayload = {
  sub: "user-cust",
  username: "customer1",
  role: "CUSTOMER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("OrdersService", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let inventoryService: { recordSale: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockGateway: {
    emitStopCompleted: jest.Mock;
    emitOrderCreated: jest.Mock;
    emitUrgentOrder: jest.Mock;
    emitOrderStatusChanged: jest.Mock;
    emitLowStock: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockQueue = { add: jest.fn() };
    mockGateway = {
      emitStopCompleted: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitUrgentOrder: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitLowStock: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: mockQueue },
        { provide: RouteFlowGateway, useValue: mockGateway },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(0.1) },
        },
        {
          provide: InvoicesService,
          useValue: {
            createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
            // W4: createInvoiceFromOrder now returns an array of sibling invoices.
            createInvoiceFromOrder: jest
              .fn()
              .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
            createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
            send: jest.fn().mockResolvedValue({ id: "inv-1", status: "SENT" }),
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
            revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
            voidInvoice: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendToCustomer: jest.fn().mockResolvedValue(undefined),
            sendToDriver: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: InventoryService,
          useValue: {
            recordSale: jest.fn().mockResolvedValue({
              unitCost: new Prisma.Decimal(0),
              stockAfter: new Prisma.Decimal(0),
            }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    inventoryService = module.get(InventoryService);
  });

  // ─── findAll ──────────────────────────────────────────────────────────────

  describe("findAll", () => {
    it("should return paginated orders for operators", async () => {
      prisma.order.findMany.mockResolvedValue([MOCK_ORDER]);
      prisma.order.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 }, operatorPayload);

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it("should scope to customer when role is CUSTOMER", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ page: 1, limit: 20 }, customerPayload);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customerId: "cust-1" }),
        }),
      );
    });

    it("should throw ForbiddenException when customer record not found", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.findAll({ page: 1, limit: 20 }, customerPayload)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should filter by status", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.findAll({ status: "PENDING" as any, page: 1, limit: 20 }, operatorPayload);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "PENDING" }),
        }),
      );
    });
  });

  // ─── findOne ──────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should return an order for operators", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      const result = await service.findOne("ord-1", operatorPayload);
      expect(result).toEqual(MOCK_ORDER);
    });

    it("should throw NotFoundException when order does not exist", async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.findOne("nonexistent", operatorPayload)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw ForbiddenException when customer does not own the order", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-other" });

      await expect(service.findOne("ord-1", customerPayload)).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── getOrderTracking (F2-002 ownership) ────────────────────────────────────
  describe("getOrderTracking", () => {
    it("throws ForbiddenException when a customer requests another customer's order", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRunStop: null });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-other" });

      await expect(service.getOrderTracking("ord-1", customerPayload)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("returns tracking for the owning customer", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRunStop: null });
      prisma.customer.findFirst.mockResolvedValue({ id: MOCK_ORDER.customerId });

      const result = await service.getOrderTracking("ord-1", customerPayload);
      expect(result).toEqual({ status: MOCK_ORDER.status, tracking: null });
    });

    it("does not run an ownership lookup for operators", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRunStop: null });

      await service.getOrderTracking("ord-1", operatorPayload);
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    });
  });

  // ─── create ───────────────────────────────────────────────────────────────

  describe("create", () => {
    it("should create an order with correct subtotal, tax, and total", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      // Tax rate is read from SystemConfigService at request time; seed 10%
      (service as any).systemConfig.get.mockImplementation((key: string) =>
        key === "settings.taxRate" ? "0.1" : null,
      );

      const result = await service.create(
        { items: [{ productId: "prod-1", qty: 3 }], urgent: false },
        customerPayload,
      );

      // Totals are rounded to cents (money discipline): 14.97, tax 1.497→1.50,
      // total 14.97+1.50 = 16.47 (not the raw FP 16.467000000000002).
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customerId: "cust-1",
            subtotal: 14.97,
            tax: 1.5,
            total: 16.47,
          }),
        }),
      );
    });

    it("P5-04: applies the best active promotion to a buyer line (net unitPrice + originalPrice + PROMO)", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]); // pricePerUnit 4.99
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      // Two matching promos → the lower net (20% off) must win.
      (service as any).promotionsService.activeForCatalog.mockResolvedValue([
        {
          id: "promo-a",
          type: "PERCENT",
          value: 10,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
        {
          id: "promo-b",
          type: "PERCENT",
          value: 20,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ]);

      await service.create({ items: [{ productId: "prod-1", qty: 3 }] }, customerPayload);

      // 20% off $4.99 → $3.99 net; strikethrough $4.99; PROMO; subtotal 3 × 3.99 = 11.97.
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  productId: "prod-1",
                  unitPrice: 3.99,
                  originalPrice: 4.99,
                  priceType: "PROMO",
                  subtotal: 11.97,
                }),
              ]),
            },
          }),
        }),
      );
    });

    it("P5-04: does NOT apply promotions to an operator-created order (staff path unchanged)", async () => {
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1, user: { status: "ACTIVE" } });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      const activeForCatalog = (service as any).promotionsService.activeForCatalog as jest.Mock;
      activeForCatalog.mockResolvedValue([
        {
          id: "promo-a",
          type: "PERCENT",
          value: 20,
          minQty: null,
          scope: "ALL",
          category: null,
          productIds: [],
        },
      ]);

      await service.create(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 3 }] } as any,
        operatorPayload,
      );

      // Promotions are never even fetched for staff, and the line stays at list price.
      expect(activeForCatalog).not.toHaveBeenCalled();
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  unitPrice: 4.99,
                  priceType: "STANDARD",
                  originalPrice: null,
                }),
              ]),
            },
          }),
        }),
      );
    });

    // ── Tier ladder (previously zero coverage — every earlier test mocked tier 1) ──

    const TIERED_PRODUCT = {
      id: "prod-1",
      name: "Tomatoes",
      pricePerUnit: 10,
      priceTier3: 8,
      priceTier4: 0, // DB default — tier never configured
      priceTier5: 7,
      unit: "each",
    };

    /** Buyer-path mocks for a customer on `tier`, no promos, no overrides. */
    const seedBuyerTierMocks = (tier: number) => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.customer.findUnique.mockResolvedValue({ pricingTier: tier });
      prisma.customerPrice.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([TIERED_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockResolvedValue("0");
      (service as any).promotionsService.activeForCatalog.mockResolvedValue([]);
    };

    it("bills a tier-3 customer the tier-3 price as SPECIAL with the list strikethrough", async () => {
      seedBuyerTierMocks(3);

      await service.create({ items: [{ productId: "prod-1", qty: 2 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  unitPrice: 8,
                  originalPrice: 10,
                  priceType: "SPECIAL",
                  subtotal: 16,
                }),
              ]),
            },
          }),
        }),
      );
    });

    it("a per-product CustomerPrice override beats the customer's default tier", async () => {
      seedBuyerTierMocks(1); // default tier 1 …
      prisma.customerPrice.findMany.mockResolvedValue([
        { productId: "prod-1", pricingTier: 5 }, // … but this product is on tier 5
      ]);

      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({ unitPrice: 7, originalPrice: 10, priceType: "SPECIAL" }),
              ]),
            },
          }),
        }),
      );
    });

    it("an unset tier column (DB default 0) falls back to the list price — never $0.00", async () => {
      seedBuyerTierMocks(4); // priceTier4 is 0 → inherit list

      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({ unitPrice: 10, subtotal: 10 }),
              ]),
            },
          }),
        }),
      );
    });

    it("RF-198 price-race compares against the TIER price, not list", async () => {
      // Buyer on tier 3 echoes the tier price → no conflict.
      seedBuyerTierMocks(3);
      await expect(
        service.create({ items: [{ productId: "prod-1", qty: 1, unitPrice: 8 }] }, customerPayload),
      ).resolves.toBeDefined();

      // Same buyer echoing the (different) list price → the cart is stale.
      seedBuyerTierMocks(3);
      await expect(
        service.create(
          { items: [{ productId: "prod-1", qty: 1, unitPrice: 10 }] },
          customerPayload,
        ),
      ).rejects.toThrow(/Prices have been updated/);
    });

    it("should throw BadRequestException when operator creates without valid customerId", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.create({ items: [] } as any, operatorPayload)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw ForbiddenException when customer record not found", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.create({ items: [] } as any, customerPayload)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should throw BadRequestException when product not found", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([]); // no matching products

      await expect(
        service.create({ items: [{ productId: "nonexistent", qty: 1 }] }, customerPayload),
      ).rejects.toThrow(BadRequestException);
    });

    it("should generate an order number starting with ORD-", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      prisma.order.create.mockResolvedValue(MOCK_ORDER);

      await service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload);

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderNumber: expect.stringMatching(/^ORD-/),
          }),
        }),
      );
    });

    it("creates an unlisted (catalog-free) line as a MANUAL-priced item with no stock movement", async () => {
      // Operator resolves the customer (with user.status) then the pricing tier —
      // both via customer.findUnique, so one object satisfies both reads.
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        user: { status: "ACTIVE" },
        pricingTier: 1,
      });
      prisma.product.findMany.mockResolvedValue([]); // no catalog ids for an unlisted line
      prisma.order.create.mockResolvedValue(MOCK_ORDER);
      (service as any).systemConfig.get.mockImplementation((key: string) =>
        key === "settings.taxRate" ? "0" : null,
      );

      await service.create(
        {
          customerId: "cust-1",
          items: [{ name: "Rush delivery fee", qty: 2, unitPrice: 10 }] as any,
        },
        operatorPayload,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lineItems: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  productId: null,
                  name: "Rush delivery fee",
                  unitPrice: 10,
                  subtotal: 20,
                  priceType: "MANUAL",
                }),
              ]),
            },
          }),
        }),
      );
      // No catalog product behind the line → stock is never touched.
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("rejects an unlisted line from a buyer (CUSTOMER role)", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([]);

      await expect(
        service.create(
          { items: [{ name: "Sneaky fee", qty: 1, unitPrice: 5 }] as any },
          customerPayload,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── createSale (order + invoice in one step) ─────────────────────────────

  describe("W6 license guard blocks unlicensed regulated sales", () => {
    const blocked = new ConflictException({
      code: "REGULATED_AUTH_REQUIRED",
      blockedCategories: [],
    });

    it("create is blocked BEFORE the order is persisted", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([MOCK_PRODUCT]);
      (service as any).systemConfig.get.mockImplementation((k: string) =>
        k === "settings.taxRate" ? "0.1" : null,
      );
      (service as any).authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(blocked);

      await expect(
        service.create({ items: [{ productId: "prod-1", qty: 1 }] }, customerPayload),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.order.create).not.toHaveBeenCalled(); // blocked before the stock tx
    });

    it("updateOrderItems is blocked on a non-draft order before mutating items", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [],
      });
      (service as any).authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(blocked);

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ productId: "prod-1", qty: 1 }] } as any,
          operatorPayload,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    });

    it("changeStatus DRAFT→PENDING promotion is blocked before the transition commits", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "DRAFT" });
      (service as any).authGuard.assertAuthorizedOrThrow.mockRejectedValueOnce(blocked);

      await expect(
        service.changeStatus("ord-1", { status: "PENDING" as any }, operatorPayload),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe("createSale", () => {
    const user = { sub: "op-1", role: UserRole.OPERATOR, tenantId: "test-tenant" } as any;
    const baseDto = {
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
      deliveredNow: true,
    } as any;
    const fakeOrder = { id: "ord-1", customerId: "cust-1", orderNumber: "ORD-1" } as any;

    beforeEach(() => {
      // Don't exercise the heavy real create() — assert the orchestration around it.
      jest.spyOn(service, "create").mockResolvedValue(fakeOrder);
    });

    it("van sale (deliveredNow=true): isolates the order, marks it DELIVERED, invoices once, sends", async () => {
      const invoices = (service as any).invoicesService;
      const result = await service.createSale({ ...baseDto, deliveredNow: true }, user);

      // A discrete sale never merges into an existing open order.
      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cust-1", status: "PENDING" }),
        user,
        { skipAutoMerge: true },
      );
      // Marked DELIVERED *directly* — bypasses changeStatus so the auto DRAFT invoice
      // never fires (no duplicate). Generated exactly one invoice, then issued it.
      expect(prisma.forTenant().order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ord-1" },
          data: expect.objectContaining({ status: OrderStatus.DELIVERED }),
        }),
      );
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledTimes(1);
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledWith("ord-1");
      expect(invoices.send).toHaveBeenCalledWith("inv-1");
      expect(result).toEqual(expect.objectContaining({ id: "inv-1" }));
    });

    it("bill before delivery (deliveredNow=false, send=false): PENDING order, draft invoice, not sent", async () => {
      const invoices = (service as any).invoicesService;
      await service.createSale({ ...baseDto, deliveredNow: false, send: false }, user);

      expect(prisma.forTenant().order.update).not.toHaveBeenCalled();
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledTimes(1);
      expect(invoices.send).not.toHaveBeenCalled();
    });

    it("deliver later NEVER auto-sends, even with send=true (the draft is the order's pending mirror)", async () => {
      const invoices = (service as any).invoicesService;
      await service.createSale({ ...baseDto, deliveredNow: false, send: true }, user);
      expect(invoices.send).not.toHaveBeenCalled();
    });
  });

  // ─── changeStatus ─────────────────────────────────────────────────────────

  describe("changeStatus", () => {
    it("should allow operators to change order status", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });

      const result = await service.changeStatus(
        "ord-1",
        { status: "CONFIRMED" as any },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { status: "CONFIRMED" },
      });
    });

    it("should throw ForbiddenException for non-operators", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-other" });
      await expect(
        service.changeStatus("ord-1", { status: "CONFIRMED" as any }, customerPayload),
      ).rejects.toThrow(ForbiddenException);
    });

    it("cancelling an order voids its pending mirror draft", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER);
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "CANCELLED" });
      const invoices = (service as any).invoicesService;
      invoices.findOpenOrderDraft.mockResolvedValueOnce({ id: "d1" });

      await service.changeStatus("ord-1", { status: "CANCELLED" as any }, operatorPayload);

      expect(invoices.voidInvoice).toHaveBeenCalledWith("d1");
    });

    it("marking DELIVERED reconciles the pending mirror (no duplicate invoice)", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, status: "CONFIRMED" });
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "DELIVERED" });
      const invoices = (service as any).invoicesService;
      invoices.findOpenOrderDraft.mockResolvedValueOnce({ id: "d1" });

      await service.changeStatus("ord-1", { status: "DELIVERED" as any }, operatorPayload);

      expect(invoices.reconcileOrderDraftInvoice).toHaveBeenCalledWith("ord-1", { basis: "order" });
      expect(invoices.createInvoiceFromOrderWithTenant).not.toHaveBeenCalled();
    });
  });

  // ─── toggleUrgent ─────────────────────────────────────────────────────────

  describe("toggleUrgent", () => {
    it("should toggle the urgent flag", async () => {
      prisma.order.findUnique.mockResolvedValue(MOCK_ORDER); // urgent: false
      prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, urgent: true });

      await service.toggleUrgent("ord-1", operatorPayload);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { urgent: true },
      });
    });

    it("should throw NotFoundException for non-existent order", async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.toggleUrgent("nonexistent", operatorPayload)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── updateOrderItems — per-line price override (DRAFT / PENDING / CONFIRMED) ─

  describe("updateOrderItems — per-line price override", () => {
    const draftOrder = {
      ...MOCK_ORDER,
      status: "DRAFT" as const,
      orderNumber: "ORD-DRAFT",
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 3,
          unitPrice: 4.99,
          subtotal: 14.97,
          status: "PENDING",
          boxes: null,
          pieces: null,
          priceType: "STANDARD",
          originalPrice: null,
        },
      ],
    };

    it("flags a lowered unit price as a MANUAL override and records audit fields", async () => {
      prisma.order.findUnique.mockResolvedValue(draftOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 4, overrideReason: "promo" }],
        },
        operatorPayload,
      );

      // Override is stored as net unitPrice + originalPrice (strikethrough) — never a
      // re-derived discount field (commit #101 convention). Subtotal goes through
      // computeLineSubtotal → 4 × 3 = 12, money-rounded.
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({
            unitPrice: 4,
            subtotal: 12,
            priceType: "MANUAL",
            originalPrice: 4.99,
            overrideReason: "promo",
            overriddenBy: "user-op",
          }),
        }),
      );
      // Order totals recomputed from the discounted line subtotal.
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ subtotal: 12 }) }),
      );
    });

    it("flags a RAISED unit price as a MANUAL upsell anchored to the catalog price", async () => {
      prisma.order.findUnique.mockResolvedValue(draftOrder);
      // The anchor reads the live catalog price for originalPrice.
      prisma.product.findUnique.mockResolvedValue({ pricePerUnit: 4.99 });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 24, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 8, overrideReason: "market" }],
        },
        operatorPayload,
      );

      // Upsell: net unitPrice ABOVE catalog, originalPrice = catalog base (< unitPrice),
      // priceType MANUAL. Subtotal via computeLineSubtotal → 8 × 3 = 24 (no double-count).
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({
            unitPrice: 8,
            subtotal: 24,
            priceType: "MANUAL",
            originalPrice: 4.99,
            overriddenBy: "user-op",
          }),
        }),
      );
    });

    it("re-editing an upsell down but still above catalog stays an upsell (anchors originalPrice to catalog, not the prior net)", async () => {
      // Line already carries a prior upsell net of 8; catalog is 5.
      const upsoldOrder = {
        ...draftOrder,
        lineItems: [
          { ...draftOrder.lineItems[0], unitPrice: 8, originalPrice: 5, priceType: "MANUAL" },
        ],
      };
      prisma.order.findUnique.mockResolvedValue(upsoldOrder);
      prisma.product.findUnique.mockResolvedValue({ pricePerUnit: 5 });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 18, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 6 }] },
        operatorPayload,
      );

      // originalPrice must be the CATALOG (5), never the prior net (8) — otherwise the
      // line would flip to a fake discount (5 < 6, but 8 > 6) and leak a bogus "was" price.
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unitPrice: 6,
            priceType: "MANUAL",
            originalPrice: 5,
          }),
        }),
      );
    });

    it("does not flag an override when the price is unchanged", async () => {
      prisma.order.findUnique.mockResolvedValue(draftOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 14.97, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 4.99 }] },
        operatorPayload,
      );

      const updateArg = prisma.orderItem.update.mock.calls[0][0] as any;
      expect(updateArg.data).not.toHaveProperty("priceType");
      expect(updateArg.data).not.toHaveProperty("originalPrice");
      expect(updateArg.data.unitPrice).toBe(4.99);
    });

    it("applies a price override on a PENDING order (not just DRAFT)", async () => {
      // The web + mobile UIs now expose price/discount editing on PENDING and
      // CONFIRMED orders, not only DRAFT. The service must honor the override on
      // those statuses exactly as it does on DRAFT.
      const pendingOrder = {
        ...draftOrder,
        status: "PENDING" as const,
        orderNumber: "ORD-PENDING",
      };
      prisma.order.findUnique.mockResolvedValue(pendingOrder);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 9, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [
            { id: "li-1", action: "UPDATE", qty: 3, unitPrice: 3, overrideReason: "loyalty" },
          ],
        },
        operatorPayload,
      );

      // Net unitPrice + originalPrice (strikethrough); subtotal via computeLineSubtotal → 3 × 3 = 9.
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-1" },
          data: expect.objectContaining({
            unitPrice: 3,
            subtotal: 9,
            priceType: "MANUAL",
            originalPrice: 4.99,
            overrideReason: "loyalty",
            overriddenBy: "user-op",
          }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ subtotal: 9 }) }),
      );
    });
  });

  // ─── updateOrderItems — incremental add vs replace-all ──────────────────────

  describe("updateOrderItems — incremental vs replace-all", () => {
    const orderWithItems = {
      ...MOCK_ORDER,
      status: "DRAFT" as const,
      lineItems: [
        {
          id: "li-A",
          orderId: "ord-1",
          productId: "prod-A",
          qty: 2,
          unitPrice: 5,
          subtotal: 10,
          status: "PENDING",
          boxes: null,
          pieces: null,
        },
      ],
    };

    it("replaceAll:false — adding an id-less item appends without deleting existing lines", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUnique.mockResolvedValue({
        id: "prod-B",
        pricePerUnit: 7,
        unitsPerBox: null,
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING" },
        { subtotal: 7, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-B", qty: 1 }], replaceAll: false },
        operatorPayload,
      );

      // The untouched existing line must survive — no wholesale delete.
      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productId: "prod-B", unitPrice: 7 }),
        }),
      );
    });

    it("edit that adds a regulated line snapshots its category + flips hasRegulated", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUnique.mockResolvedValue({
        id: "prod-tob",
        pricePerUnit: 7,
        unitsPerBox: null,
        trackedCategoryId: "cat-tob",
      });
      // Post-edit active items include the newly-added regulated line.
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING", trackedCategoryId: null },
        { subtotal: 7, status: "PENDING", trackedCategoryId: "cat-tob" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-tob", qty: 1 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productId: "prod-tob", trackedCategoryId: "cat-tob" }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ hasRegulated: true }) }),
      );
    });

    it("customer replace path snapshots a regulated line's category", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...orderWithItems, customerId: "cust-1" });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-tob", pricePerUnit: 7, unitsPerBox: null, trackedCategoryId: "cat-tob" },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 7, status: "PENDING", trackedCategoryId: "cat-tob" },
      ]);

      await service.updateOrderItems("ord-1", { items: [{ productId: "prod-tob", qty: 1 }] }, {
        ...customerPayload,
        sub: "user-cust",
      } as any);

      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ productId: "prod-tob", trackedCategoryId: "cat-tob" }),
        }),
      );
    });

    it("substituting to a regulated product re-snapshots the new category", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-tob",
        pricePerUnit: 8,
        unitsPerBox: null,
        trackedCategoryId: "cat-tob",
      });
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 16, status: "PENDING", trackedCategoryId: "cat-tob" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", substituteProductId: "prod-tob", qty: 2 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-tob",
            trackedCategoryId: "cat-tob",
          }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ hasRegulated: true }) }),
      );
    });

    it("legacy heuristic — an all-id-less payload with no flag still replaces all (mobile)", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-B", pricePerUnit: 7, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 7, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-B", qty: 1 }] },
        operatorPayload,
      );

      expect(prisma.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: "ord-1" } });
    });

    it("appends a new unlisted line (no productId) as a MANUAL item, without deleting", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 10, status: "PENDING" },
        { subtotal: 15, status: "PENDING" },
      ]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ name: "Custom crate", qty: 3, unitPrice: 5 }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: null,
            name: "Custom crate",
            unitPrice: 5,
            subtotal: 15,
            priceType: "MANUAL",
          }),
        }),
      );
    });

    it("action DELETE hard-removes a clean (un-invoiced, undelivered) line", async () => {
      prisma.order.findUnique.mockResolvedValue(orderWithItems);
      prisma.deliveryMutation.count.mockResolvedValue(0);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", action: "DELETE" }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.delete).toHaveBeenCalledWith({ where: { id: "li-A" } });
    });

    it("action DELETE falls back to strike-off when the line was already invoiced", async () => {
      const billed = {
        ...orderWithItems,
        lineItems: [{ ...orderWithItems.lineItems[0], invoicedQty: 2 }],
      };
      prisma.order.findUnique.mockResolvedValue(billed);
      prisma.deliveryMutation.count.mockResolvedValue(0);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-A", action: "DELETE" }], replaceAll: false },
        operatorPayload,
      );

      expect(prisma.orderItem.delete).not.toHaveBeenCalled();
      expect(prisma.orderItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "li-A" },
          data: expect.objectContaining({ status: "CANCELLED" }),
        }),
      );
    });
  });

  // ─── updateShipment (carrier tracking on the order + its invoices) ──────────

  // ─── updateOrderItems — boxed line proration (edit over-charge fix) ─────────
  // A boxed product prices by the BOX (unitPrice = box price, qty = piece count),
  // so an edited boxed line must prorate as unitPrice*(boxes + pieces/unitsPerBox).
  // Regression guard against dropping boxes/pieces → unitPrice*qty over-charge.

  describe("updateOrderItems — boxed line proration", () => {
    it("customer edit of a PIECE-denominated boxed line re-prorates (not unitPrice*qty)", async () => {
      // The existing line was stored box-aware (boxes/pieces set) → qty is pieces.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [
          {
            id: "li-box",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 12,
            unitPrice: 28.35,
            subtotal: 28.35,
            status: "PENDING",
            boxes: 1,
            pieces: 0,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", pricePerUnit: 28.35, unitsPerBox: 12 },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      // Buyer sets qty = 27 pieces (= 2 boxes + 3) of a 12-per-box product.
      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-box", qty: 27 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      // 28.35 * (2 + 3/12) = 63.7875 → 63.79 — NOT 28.35 * 27 = 765.45.
      expect(created.subtotal).toBeCloseTo(63.79, 2);
      expect(created.subtotal).not.toBeCloseTo(765.45, 2);
      expect(created.qty).toBe(27);
      expect(created.boxes).toBe(2);
      expect(created.pieces).toBe(3);
    });

    it("customer edit of a SELLING-UNIT boxed line (boxes null) does NOT re-prorate", async () => {
      // Regression guard: a box-UNAWARE line (e.g. from the mobile cart) stores
      // qty as a box count with boxes=null. Re-splitting it as pieces would
      // UNDER-charge (e.g. a $120 / 2-box line → $20). It must stay unitPrice*qty.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [
          {
            id: "li-boxunaware",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 2,
            unitPrice: 60,
            subtotal: 120,
            status: "PENDING",
            boxes: null,
            pieces: null,
          },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", pricePerUnit: 60, unitsPerBox: 6 },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-box", qty: 2 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      // 2 boxes * $60 = $120 — must NOT become $60*(2/6) = $20.
      expect(created.subtotal).toBeCloseTo(120, 2);
      expect(created.subtotal).not.toBeCloseTo(20, 2);
      expect(created.qty).toBe(2);
      expect(created.boxes).toBeNull();
      expect(created.pieces).toBeNull();
    });

    it("customer edit of a non-boxed product still charges unitPrice*qty", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "PENDING",
        lineItems: [],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-plain", pricePerUnit: 3.5, unitsPerBox: null },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ productId: "prod-plain", qty: 5 }] },
        customerPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.subtotal).toBeCloseTo(17.5, 2); // 3.5 * 5
      expect(created.boxes).toBeNull();
      expect(created.pieces).toBeNull();
    });

    it("operator UPDATE prorates a boxed line when the client sends boxes/pieces", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT",
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 12,
            unitPrice: 28.35,
            subtotal: 28.35,
            status: "PENDING",
            boxes: 1,
            pieces: 0,
          },
        ],
      });
      prisma.product.findUnique.mockResolvedValue({ id: "prod-box", unitsPerBox: 12 });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 63.79, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ id: "li-1", action: "UPDATE", qty: 27, boxes: 2, pieces: 3 }],
          replaceAll: false,
        },
        operatorPayload,
      );

      const updated = prisma.orderItem.update.mock.calls[0][0].data;
      expect(updated.subtotal).toBeCloseTo(63.79, 2);
      expect(updated.subtotal).not.toBeCloseTo(765.45, 2);
      expect(updated.qty).toBe(27);
      expect(updated.boxes).toBe(2);
      expect(updated.pieces).toBe(3);
    });

    it("operator replaceAll prorates a boxed line from boxes/pieces", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT",
        lineItems: [],
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-box", pricePerUnit: 28.35, unitsPerBox: 12 },
      ]);
      prisma.orderItem.findMany.mockResolvedValue([]);

      await service.updateOrderItems(
        "ord-1",
        {
          items: [{ productId: "prod-box", qty: 27, boxes: 2, pieces: 3 }],
          replaceAll: true,
        },
        operatorPayload,
      );

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.subtotal).toBeCloseTo(63.79, 2);
      expect(created.subtotal).not.toBeCloseTo(765.45, 2);
      expect(created.qty).toBe(27);
      expect(created.boxes).toBe(2);
      expect(created.pieces).toBe(3);
    });

    it("qty-ONLY edit of a box-split line re-derives the split and prorates the box price (reverse-divergence fix)", async () => {
      // Existing box-split line: 1 box of 12 @ $28.35/box, snapshot upb=12.
      // Editing qty to 24 pieces (2 boxes) must prorate to $56.70 and refresh the
      // split to boxes=2/pieces=0 — NOT bill 24 × $28.35 and leave boxes=1 stale.
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        status: "DRAFT",
        lineItems: [
          {
            id: "li-1",
            orderId: "ord-1",
            productId: "prod-box",
            qty: 12,
            unitPrice: 28.35,
            subtotal: 28.35,
            status: "PENDING",
            boxes: 1,
            pieces: 0,
            unitsPerBox: 12,
          },
        ],
      });
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 56.7, status: "PENDING" }]);

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 24 }], replaceAll: false },
        operatorPayload,
      );

      const updated = prisma.orderItem.update.mock.calls[0][0].data;
      expect(updated.subtotal).toBeCloseTo(56.7, 2);
      expect(updated.subtotal).not.toBeCloseTo(680.4, 2); // 24 × 28.35 (the old bug)
      expect(updated.qty).toBe(24);
      expect(updated.boxes).toBe(2);
      expect(updated.pieces).toBe(0);
    });
  });

  // ─── Order merge/consolidate — boxed line proration ─────────────────────────
  // Merging PENDING orders must re-prorate boxed lines by the combined PIECE
  // count, never a naive summed-qty * unitPrice (which over-charged by
  // unitsPerBox). Contributions normalize to pieces, re-split, price via
  // computeLineSubtotal; merged lines come out piece-denominated.

  describe("mergeAllPendingForCustomer — boxed proration", () => {
    const boxLine = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      orderId: "o?",
      productId: "prod-box",
      qty: 6,
      unitPrice: 60,
      subtotal: 60,
      status: "PENDING",
      priceType: "STANDARD",
      originalPrice: null,
      name: null,
      overrideReason: null,
      overriddenBy: null,
      boxes: 1,
      pieces: 0,
      ...extra,
    });

    it("re-prorates a piece-denominated boxed winner line (2 boxes = $120, not $720)", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("wl1")] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll1")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      // 6 pieces + 6 pieces = 12 → 2 boxes → $60 * 2 = $120. NOT 12 * $60 = $720.
      expect(upd.subtotal).toBeCloseTo(120, 2);
      expect(upd.subtotal).not.toBeCloseTo(720, 2);
      expect(upd.qty).toBe(12);
      expect(upd.boxes).toBe(2);
      expect(upd.pieces).toBe(0);
    });

    it("preserves a loser regulated line's tracked-category snapshot + flips hasRegulated", async () => {
      const line = (id: string, extra: Record<string, unknown>) => ({
        id,
        productId: "p?",
        qty: 1,
        unitPrice: 5,
        subtotal: 5,
        status: "PENDING",
        priceType: "STANDARD",
        originalPrice: null,
        name: null,
        overrideReason: null,
        overriddenBy: null,
        boxes: null,
        pieces: null,
        trackedCategoryId: null,
        ...extra,
      });
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [line("wl1", { productId: "prod-std" })],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          // A regulated line, only on the loser → becomes a NEW winner item.
          lineItems: [line("ll1", { productId: "prod-tob", trackedCategoryId: "cat-tob" })],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-std", unitsPerBox: null },
        { id: "prod-tob", unitsPerBox: null },
      ]);
      // activeItems (post-merge totals + hasRegulated recompute) include the reg line.
      prisma.orderItem.findMany.mockResolvedValue([
        { subtotal: 5, trackedCategoryId: null },
        { subtotal: 5, trackedCategoryId: "cat-tob" },
      ]);

      await service.mergeAllPendingForCustomer("cust-1");

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.productId).toBe("prod-tob");
      expect(created.trackedCategoryId).toBe("cat-tob"); // snapshot survived the merge
      const upd = prisma.order.update.mock.calls.at(-1)![0].data;
      expect(upd.hasRegulated).toBe(true);
    });

    it("heals a selling-unit (boxes null) boxed merge to piece-denominated $120", async () => {
      // Two mobile-created box-count lines (qty = boxes, boxes/pieces null).
      const su = (id: string) => boxLine(id, { qty: 1, boxes: null, pieces: null });
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [su("wl1")] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [su("ll1")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      // 1 box * 6 + 1 box * 6 = 12 pieces → 2 boxes → $120; now piece-denominated.
      expect(upd.subtotal).toBeCloseTo(120, 2);
      expect(upd.qty).toBe(12);
      expect(upd.boxes).toBe(2);
      expect(upd.pieces).toBe(0);
    });

    it("merges MIXED denominations (box-split winner + selling-unit loser) correctly", async () => {
      // Winner: box-split 1 box + 2 loose (qty 8 pieces). Loser: selling-unit 1 box (qty 1).
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [boxLine("wl1", { qty: 8, boxes: 1, pieces: 2 })],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [boxLine("ll1", { qty: 1, boxes: null, pieces: null })],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      // 8 pieces + (1 box * 6) = 14 pieces → 2 boxes + 2 loose → 60*(2 + 2/6) = $140.
      expect(upd.subtotal).toBeCloseTo(140, 2);
      expect(upd.qty).toBe(14);
      expect(upd.boxes).toBe(2);
      expect(upd.pieces).toBe(2);
    });

    it("sums MULTIPLE losers for one product (contributions array, not overwrite)", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("wl1")] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll1")] },
        { id: "l2", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll2")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      // 6 + 6 + 6 = 18 pieces → 3 boxes → $180 (all three contributions counted).
      expect(upd.subtotal).toBeCloseTo(180, 2);
      expect(upd.qty).toBe(18);
      expect(upd.boxes).toBe(3);
    });

    it("recomputes the order header total from the prorated line subtotals", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("wl1")] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll1")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);
      // The in-tx recompute reads the (now merged) active line — return the $120 line.
      prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 120, status: "PENDING" }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const orderUpd = prisma.order.update.mock.calls.find((c) => c[0]?.data?.subtotal != null);
      expect(orderUpd).toBeDefined();
      // taxRate mock = 0 (systemConfig.get → null), so subtotal 120, tax 0, total 120 — NOT $720-based.
      expect(orderUpd![0].data.subtotal).toBeCloseTo(120, 2);
      expect(orderUpd![0].data.total).toBeCloseTo(120, 2);
    });

    it("creates a boxed winner line from a loser-only product, prorated", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [] },
        { id: "l1", customerId: "cust-1", status: "PENDING", lineItems: [boxLine("ll1")] },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const created = prisma.orderItem.create.mock.calls[0][0].data;
      expect(created.productId).toBe("prod-box");
      expect(created.subtotal).toBeCloseTo(60, 2); // 1 box
      expect(created.qty).toBe(6);
      expect(created.boxes).toBe(1);
      expect(created.pieces).toBe(0);
    });

    it("leaves a non-boxed line as summed qty * unitPrice", async () => {
      const plain = (id: string) => ({
        id,
        productId: "prod-plain",
        qty: 2,
        unitPrice: 5,
        subtotal: 10,
        status: "PENDING",
        priceType: "STANDARD",
        originalPrice: null,
        name: null,
        overrideReason: null,
        overriddenBy: null,
        boxes: null,
        pieces: null,
      });
      prisma.order.findMany.mockResolvedValue([
        { id: "w1", customerId: "cust-1", status: "PENDING", lineItems: [plain("wl1")] },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          lineItems: [{ ...plain("ll1"), qty: 3, subtotal: 15 }],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-plain", unitsPerBox: null }]);

      await service.mergeAllPendingForCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      expect(upd.subtotal).toBeCloseTo(25, 2); // (2 + 3) * $5
      expect(upd.qty).toBe(5);
      expect(upd.boxes).toBeNull();
    });
  });

  describe("forceConsolidateCustomer — boxed proration", () => {
    it("re-prorates a piece-denominated boxed winner line (2 boxes = $120, not $720)", async () => {
      const boxLine = (id: string) => ({
        id,
        productId: "prod-box",
        qty: 6,
        unitPrice: 60,
        subtotal: 60,
        status: "PENDING",
        priceType: "STANDARD",
        originalPrice: null,
        name: null,
        overrideReason: null,
        overriddenBy: null,
        boxes: 1,
        pieces: 0,
      });
      prisma.order.findMany.mockResolvedValue([
        {
          id: "w1",
          customerId: "cust-1",
          status: "PENDING",
          routeRunId: null,
          lineItems: [boxLine("wl1")],
        },
        {
          id: "l1",
          customerId: "cust-1",
          status: "PENDING",
          routeRunId: null,
          lineItems: [boxLine("ll1")],
        },
      ]);
      prisma.product.findMany.mockResolvedValue([{ id: "prod-box", unitsPerBox: 6 }]);

      await service.forceConsolidateCustomer("cust-1");

      const upd = prisma.orderItem.update.mock.calls[0][0].data;
      expect(upd.subtotal).toBeCloseTo(120, 2);
      expect(upd.subtotal).not.toBeCloseTo(720, 2);
      expect(upd.qty).toBe(12);
      expect(upd.boxes).toBe(2);
    });
  });

  describe("updateShipment", () => {
    it("sets carrier + tracking on the order and mirrors them to non-void invoices", async () => {
      prisma.order.findUnique.mockResolvedValue({ id: "ord-1", shippedAt: null });
      prisma.order.update.mockResolvedValue({ id: "ord-1" });

      await service.updateShipment(
        "ord-1",
        { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999AA10123456784" },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "ord-1" },
          data: expect.objectContaining({
            shippingCarrier: "UPS",
            shippingTrackingNumber: "1Z999AA10123456784",
            shippedAt: expect.any(Date),
          }),
        }),
      );
      expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: "ord-1", status: { not: "VOID" } },
          data: expect.objectContaining({
            shippingCarrier: "UPS",
            shippingTrackingNumber: "1Z999AA10123456784",
          }),
        }),
      );
    });

    it("clears carrier, tracking and shippedAt when the tracking number is blank", async () => {
      prisma.order.findUnique.mockResolvedValue({ id: "ord-1", shippedAt: new Date() });
      prisma.order.update.mockResolvedValue({ id: "ord-1" });

      await service.updateShipment(
        "ord-1",
        { shippingCarrier: "", shippingTrackingNumber: "" },
        operatorPayload,
      );

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            shippingCarrier: null,
            shippingTrackingNumber: null,
            shippedAt: null,
          }),
        }),
      );
    });
  });

  // ─── P5-08: edit window (G7) + OrderRevision versioning ─────────────────────
  describe("updateOrderItems — edit window + revisions (P5-08)", () => {
    const confirmedOrder = (routeRun: { status: string; startedAt: Date | null } | null) => ({
      ...MOCK_ORDER,
      status: "CONFIRMED" as const,
      routeRun,
      lineItems: [
        {
          id: "li-1",
          orderId: "ord-1",
          productId: "prod-1",
          qty: 2,
          unitPrice: 5,
          subtotal: 10,
          status: "PENDING",
          boxes: null,
          pieces: null,
          priceType: "STANDARD",
          originalPrice: null,
        },
      ],
    });

    it("blocks a direct edit once the order's run has dispatched (EDIT_WINDOW_CLOSED)", async () => {
      prisma.order.findUnique.mockResolvedValue(
        confirmedOrder({ status: "IN_PROGRESS", startedAt: new Date() }),
      );

      await expect(
        service.updateOrderItems(
          "ord-1",
          { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 5 }] },
          operatorPayload,
        ),
      ).rejects.toMatchObject({ response: { code: "EDIT_WINDOW_CLOSED", reason: "DISPATCHED" } });

      // Nothing was mutated and no revision was appended on a blocked edit.
      expect(prisma.orderItem.update).not.toHaveBeenCalled();
      expect(prisma.orderRevision.create).not.toHaveBeenCalled();
    });

    it("allows the edit while the run is still SCHEDULED and appends a revision", async () => {
      prisma.order.findUnique.mockResolvedValue(
        confirmedOrder({ status: "SCHEDULED", startedAt: null }),
      );
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 3, unitPrice: 5, subtotal: 15, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: 1 } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 3, unitPrice: 5 }] },
        operatorPayload,
      );

      expect(prisma.orderRevision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderId: "ord-1",
            revisionNumber: 2, // max(1) + 1
            source: "EDIT",
            editedByRole: "OPERATOR",
            snapshot: expect.objectContaining({ subtotal: 15, lineItems: expect.any(Array) }),
          }),
        }),
      );
    });

    it("numbers the first revision 1 when none exist yet", async () => {
      prisma.order.findUnique.mockResolvedValue(confirmedOrder(null));
      prisma.orderItem.findMany.mockResolvedValue([
        { id: "li-1", productId: "prod-1", qty: 2, unitPrice: 5, subtotal: 10, status: "PENDING" },
      ]);
      prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });

      await service.updateOrderItems(
        "ord-1",
        { items: [{ id: "li-1", action: "UPDATE", qty: 2, unitPrice: 5 }] },
        operatorPayload,
      );

      expect(prisma.orderRevision.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ revisionNumber: 1 }) }),
      );
    });

    it("findOne reports the edit window open for an order with no run", async () => {
      prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, routeRun: null, revisions: [] });
      const result: any = await service.findOne("ord-1", operatorPayload);
      expect(result.editWindow).toEqual({
        editable: true,
        editableUntil: null,
        closedReason: null,
      });
    });

    it("findOne reports the edit window closed (DISPATCHED) once the run started", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...MOCK_ORDER,
        routeRun: { status: "IN_PROGRESS", startedAt: new Date() },
        revisions: [],
      });
      const result: any = await service.findOne("ord-1", operatorPayload);
      expect(result.editWindow).toMatchObject({ editable: false, closedReason: "DISPATCHED" });
    });
  });
});
