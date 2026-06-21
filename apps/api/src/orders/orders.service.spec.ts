import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
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
import { OrderStatus, UserRole } from "@prisma/client";

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
            createInvoiceFromOrder: jest
              .fn()
              .mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-1" }),
            createInvoiceFromOrderWithTenant: jest.fn().mockResolvedValue({ id: "inv-1" }),
            send: jest.fn().mockResolvedValue({ id: "inv-1", status: "SENT" }),
            findOpenOrderDraft: jest.fn().mockResolvedValue(null),
            reconcileOrderDraftInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
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
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
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
  });

  // ─── createSale (order + invoice in one step) ─────────────────────────────

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
});
