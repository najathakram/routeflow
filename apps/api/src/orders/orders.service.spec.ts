import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";

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

      const result = await service.create(
        { items: [{ productId: "prod-1", qty: 3 }], urgent: false },
        customerPayload,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customerId: "cust-1",
            subtotal: 4.99 * 3,
            tax: 4.99 * 3 * 0.1,
            total: 4.99 * 3 * 1.1,
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
