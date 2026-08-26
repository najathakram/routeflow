import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";

import { ChangeRequestsService } from "./change-requests.service";
import { OrdersService } from "./orders.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ChangeRequestResolveAction } from "./dto/resolve-change-request.dto";
import { JwtPayload } from "../auth/jwt-payload.interface";

const customerUser: JwtPayload = {
  sub: "user-cust",
  username: "buyer1",
  role: "CUSTOMER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "test-tenant",
  tenantSlug: "test",
};

const driverUser: JwtPayload = {
  sub: "user-drv",
  username: "driver1",
  role: "DRIVER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "test-tenant",
  tenantSlug: "test",
};

const operatorUser: JwtPayload = {
  sub: "user-op",
  username: "operator1",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "test-tenant",
  tenantSlug: "test",
};

const dispatchedOrder = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-100",
  total: 16.47,
  status: "OUT_FOR_DELIVERY" as const,
  routeRunId: "run-1",
  routeRunStopId: "stop-1",
  lineItems: [
    { id: "item-1", productId: "prod-1", status: "PENDING" as const, qty: 5 },
    { id: "item-cancelled", productId: "prod-2", status: "CANCELLED" as const, qty: 3 },
  ],
  routeRun: { status: "IN_PROGRESS" as const },
};

const PENDING_CR = {
  id: "cr-1",
  orderId: "ord-1",
  orderItemId: null,
  productId: "prod-1",
  type: "ADD_ITEM" as const,
  status: "PENDING" as const,
  payload: { productId: "prod-1", qty: 3, productName: "Tomatoes" },
  note: null,
  requestedById: "user-cust",
  requestedByName: "buyer1",
  requestedByRole: "CUSTOMER",
};

describe("ChangeRequestsService", () => {
  let service: ChangeRequestsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ordersService: {
    approveChangeRequestAtStop: jest.Mock;
    assertCreditForProjectedOrder: jest.Mock;
    create: jest.Mock;
    deleteOrder: jest.Mock;
  };
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };
  let authGuard: { assertAuthorizedOrThrow: jest.Mock };
  let messaging: { notify: jest.Mock; notifyEvent: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();

    ordersService = {
      approveChangeRequestAtStop: jest
        .fn()
        .mockResolvedValue({ merged: true, subtotal: 10, tax: 1, total: 11 }),
      assertCreditForProjectedOrder: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue({ id: "draft-1", total: 9.99 }),
      deleteOrder: jest.fn().mockResolvedValue(undefined),
    };
    notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(undefined),
      sendToUser: jest.fn().mockResolvedValue(undefined),
    };
    authGuard = { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) };
    messaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChangeRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrdersService, useValue: ordersService },
        { provide: NotificationsService, useValue: notifications },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: MessagingService, useValue: messaging },
      ],
    }).compile();

    service = module.get<ChangeRequestsService>(ChangeRequestsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── create() ───────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates a PENDING ADD_ITEM change request on a dispatched order", async () => {
      prisma.order.findUnique.mockResolvedValue(dispatchedOrder);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findFirst.mockResolvedValue({ id: "prod-1", name: "Tomatoes" });
      prisma.changeRequest.create.mockResolvedValue({ id: "cr-new", status: "PENDING" });

      await service.create(
        "ord-1",
        { type: "ADD_ITEM" as any, productId: "prod-1", qty: 3 },
        customerUser,
      );

      expect(prisma.changeRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: "ord-1",
          type: "ADD_ITEM",
          payload: {
            productId: "prod-1",
            qty: 3,
            boxes: null,
            pieces: null,
            productName: "Tomatoes",
          },
          routeRunStopId: "stop-1",
          requestedById: customerUser.sub,
          requestedByName: customerUser.username,
          requestedByRole: customerUser.role,
        }),
      });
      // status is left to the Prisma column default (PENDING) — never set explicitly.
      expect(prisma.changeRequest.create.mock.calls[0][0].data.status).toBeUndefined();
    });

    // P6-5: transactional trigger — ORDER_CHANGED_AT_DOOR fires on creation.
    it("fires ORDER_CHANGED_AT_DOOR via MessagingService on ADD_ITEM creation", async () => {
      prisma.order.findUnique.mockResolvedValue(dispatchedOrder);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.product.findFirst.mockResolvedValue({ id: "prod-1", name: "Tomatoes" });
      prisma.changeRequest.create.mockResolvedValue({ id: "cr-new", status: "PENDING" });

      await service.create(
        "ord-1",
        { type: "ADD_ITEM" as any, productId: "prod-1", qty: 3 },
        customerUser,
      );

      expect(messaging.notifyEvent).toHaveBeenCalledWith(
        "ORDER_CHANGED_AT_DOOR",
        expect.objectContaining({
          customerId: "cust-1",
          senderId: customerUser.sub,
          vars: expect.objectContaining({
            orderNumber: "ORD-100",
            changeSummary: expect.stringContaining("Tomatoes"),
            orderTotal: "$16.47",
          }),
        }),
      );
    });

    it("rejects with EDIT_WINDOW_OPEN while the run is still SCHEDULED", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...dispatchedOrder,
        routeRun: { status: "SCHEDULED" },
      });

      await expect(
        service.create("ord-1", { type: "NOTE" as any, note: "hi" }, operatorUser),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "EDIT_WINDOW_OPEN" }),
      });
      expect(prisma.changeRequest.create).not.toHaveBeenCalled();
      expect(messaging.notifyEvent).not.toHaveBeenCalled();
    });

    it("rejects with CHANGE_WINDOW_CLOSED once the run has completed", async () => {
      prisma.order.findUnique.mockResolvedValue({
        ...dispatchedOrder,
        status: "DELIVERED",
        routeRun: { status: "COMPLETED" },
      });

      await expect(
        service.create("ord-1", { type: "NOTE" as any, note: "hi" }, operatorUser),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "CHANGE_WINDOW_CLOSED" }),
      });
      expect(prisma.changeRequest.create).not.toHaveBeenCalled();
    });

    it("forbids a CUSTOMER filing against an order they do not own", async () => {
      prisma.order.findUnique.mockResolvedValue(dispatchedOrder);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-OTHER" });

      await expect(
        service.create("ord-1", { type: "NOTE" as any, note: "hi" }, customerUser),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.changeRequest.create).not.toHaveBeenCalled();
    });

    it("rejects CHANGE_QTY against an unknown/cancelled order line", async () => {
      prisma.order.findUnique.mockResolvedValue(dispatchedOrder);

      await expect(
        service.create(
          "ord-1",
          { type: "CHANGE_QTY" as any, orderItemId: "item-cancelled", qty: 4 },
          operatorUser,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.create(
          "ord-1",
          { type: "CHANGE_QTY" as any, orderItemId: "does-not-exist", qty: 4 },
          operatorUser,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.changeRequest.create).not.toHaveBeenCalled();
    });
  });

  // ─── listForOrder() ─────────────────────────────────────────────────────

  describe("listForOrder", () => {
    it("404s when the order does not exist", async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.listForOrder("missing", operatorUser)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("forbids a CUSTOMER listing another customer's order", async () => {
      prisma.order.findFirst.mockResolvedValue({ id: "ord-1", customerId: "cust-1" });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-OTHER" });
      await expect(service.listForOrder("ord-1", customerUser)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ─── resolve() ──────────────────────────────────────────────────────────

  describe("resolve — DECLINE", () => {
    beforeEach(() => {
      prisma.changeRequest.findFirst.mockResolvedValue(PENDING_CR);
      prisma.order.findUnique.mockResolvedValue({
        ...dispatchedOrder,
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
    });

    it("requires a non-empty reason", async () => {
      await expect(
        service.resolve(
          "ord-1",
          "cr-1",
          { action: ChangeRequestResolveAction.DECLINE },
          operatorUser,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
    });

    it("claims + declines with a reason and notifies the CUSTOMER requester", async () => {
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.changeRequest.findUnique.mockResolvedValue({ ...PENDING_CR, status: "DECLINED" });

      await service.resolve(
        "ord-1",
        "cr-1",
        { action: ChangeRequestResolveAction.DECLINE, reason: "Out of stock today" },
        operatorUser,
      );

      expect(prisma.changeRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "cr-1", status: "PENDING" },
        data: expect.objectContaining({
          status: "DECLINED",
          resolutionReason: "Out of stock today",
        }),
      });
      expect(notifications.sendToCustomer).toHaveBeenCalledWith(
        "cust-1",
        expect.stringContaining("declined"),
        expect.stringContaining("Out of stock today"),
        expect.anything(),
      );
      expect(notifications.sendToUser).not.toHaveBeenCalled();
    });

    it("notifies via sendToUser for a DRIVER requester", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue({
        ...PENDING_CR,
        requestedById: "user-drv",
        requestedByRole: "DRIVER",
      });
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.changeRequest.findUnique.mockResolvedValue({ ...PENDING_CR, status: "DECLINED" });

      await service.resolve(
        "ord-1",
        "cr-1",
        { action: ChangeRequestResolveAction.DECLINE, reason: "Not available" },
        operatorUser,
      );

      expect(notifications.sendToUser).toHaveBeenCalledWith(
        "user-drv",
        expect.objectContaining({ body: expect.stringContaining("Not available") }),
      );
      expect(notifications.sendToCustomer).not.toHaveBeenCalled();
    });

    it("G6 race: a lost decline claim 409s and sends no notification", async () => {
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.resolve(
          "ord-1",
          "cr-1",
          { action: ChangeRequestResolveAction.DECLINE, reason: "too late" },
          operatorUser,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(notifications.sendToCustomer).not.toHaveBeenCalled();
      expect(notifications.sendToUser).not.toHaveBeenCalled();
    });
  });

  describe("resolve — APPROVE_AT_STOP", () => {
    beforeEach(() => {
      prisma.changeRequest.findFirst.mockResolvedValue(PENDING_CR);
      prisma.order.findUnique.mockResolvedValue({
        ...dispatchedOrder,
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
      prisma.changeRequest.findUnique.mockResolvedValue({ ...PENDING_CR, status: "APPROVED" });
    });

    it("delegates the merge to OrdersService and notifies the requester as approved", async () => {
      await service.resolve(
        "ord-1",
        "cr-1",
        { action: ChangeRequestResolveAction.APPROVE_AT_STOP, reason: "on the truck" },
        operatorUser,
      );

      expect(ordersService.approveChangeRequestAtStop).toHaveBeenCalledWith(
        "cr-1",
        operatorUser,
        "on the truck",
      );
      expect(notifications.sendToCustomer).toHaveBeenCalledWith(
        "cust-1",
        expect.stringContaining("approved"),
        expect.any(String),
        expect.anything(),
      );
    });
  });

  describe("resolve — APPROVE_NEXT_DELIVERY", () => {
    beforeEach(() => {
      prisma.order.findUnique.mockResolvedValue({
        ...dispatchedOrder,
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
      prisma.product.findFirst.mockResolvedValue({ id: "prod-1", trackedCategoryId: null });
      prisma.customer.findFirst.mockResolvedValue({ userId: "user-cust" });
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.changeRequest.findUnique.mockResolvedValue({ ...PENDING_CR, status: "APPROVED" });
    });

    it("drafts a next-delivery order for ADD_ITEM, re-checks guards, and stamps nextOrderId", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(PENDING_CR);

      await service.resolve(
        "ord-1",
        "cr-1",
        { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
        operatorUser,
      );

      expect(authGuard.assertAuthorizedOrThrow).toHaveBeenCalledWith({
        customerId: "cust-1",
        lines: [{ trackedCategoryId: null }],
        orderId: "ord-1",
      });
      expect(ordersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [{ productId: "prod-1", qty: 3 }],
          status: "DRAFT",
        }),
        expect.objectContaining({ role: "CUSTOMER", sub: "user-cust" }),
        { skipAutoMerge: false },
      );
      expect(ordersService.assertCreditForProjectedOrder).toHaveBeenCalledWith(
        "cust-1",
        "draft-1",
        9.99,
      );
      expect(prisma.changeRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "cr-1", status: "PENDING" },
        data: expect.objectContaining({ nextOrderId: "draft-1", resolution: "NEXT_DELIVERY" }),
      });
    });

    it("G6 race: a lost claim compensates by deleting the just-created draft", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(PENDING_CR);
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.resolve(
          "ord-1",
          "cr-1",
          { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
          operatorUser,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(ordersService.deleteOrder).toHaveBeenCalledWith("draft-1");
    });

    it("credit-guard rejection compensates by deleting the draft and rethrows", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(PENDING_CR);
      ordersService.assertCreditForProjectedOrder.mockRejectedValue(
        new ConflictException({ code: "CREDIT_LIMIT_EXCEEDED" }),
      );

      await expect(
        service.resolve(
          "ord-1",
          "cr-1",
          { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
          operatorUser,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(ordersService.deleteOrder).toHaveBeenCalledWith("draft-1");
      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
    });

    it("400s INVALID_RESOLUTION_FOR_TYPE for REMOVE_ITEM and NOTE requests", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue({
        ...PENDING_CR,
        type: "REMOVE_ITEM",
        orderItemId: "item-1",
        payload: { orderItemId: "item-1" },
      });

      await expect(
        service.resolve(
          "ord-1",
          "cr-1",
          { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
          operatorUser,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      prisma.changeRequest.findFirst.mockResolvedValue({
        ...PENDING_CR,
        type: "NOTE",
        payload: { text: "please call ahead" },
      });

      await expect(
        service.resolve(
          "ord-1",
          "cr-1",
          { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
          operatorUser,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(ordersService.create).not.toHaveBeenCalled();
    });
  });

  describe("resolve — driver authority (G6)", () => {
    it("forbids a DRIVER not assigned to the order's run", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(PENDING_CR);
      prisma.order.findUnique.mockResolvedValue({
        ...dispatchedOrder,
        routeRun: { driverId: "drv-OTHER", status: "IN_PROGRESS" },
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      await expect(
        service.resolve(
          "ord-1",
          "cr-1",
          { action: ChangeRequestResolveAction.DECLINE, reason: "n/a" },
          driverUser,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
    });

    it("allows the assigned driver to resolve", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(PENDING_CR);
      prisma.order.findUnique.mockResolvedValue({
        ...dispatchedOrder,
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.changeRequest.findUnique.mockResolvedValue({ ...PENDING_CR, status: "DECLINED" });

      await expect(
        service.resolve(
          "ord-1",
          "cr-1",
          { action: ChangeRequestResolveAction.DECLINE, reason: "no room on truck" },
          driverUser,
        ),
      ).resolves.toBeDefined();
    });
  });
});
