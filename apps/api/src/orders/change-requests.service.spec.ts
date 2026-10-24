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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { computeLineSubtotal, normalizeBoxesPieces } from "@routeflow/pricing";
import { ChangeRequestResolveAction } from "./dto/resolve-change-request.dto";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";

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

// F1(iii): a buyer's filing judges the product's portal visibility, so the row carries those facts.
const VISIBLE_TOMATOES = {
  id: "prod-1",
  name: "Tomatoes",
  isActive: true,
  kind: "STANDARD",
  portalVisible: true,
  parent: null,
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

// B655: a CHANGE_QTY request approved to the next delivery. `payload.newQty` is the line's NEW
// ABSOLUTE qty (in pieces); the resolved delta must never ride into create() as a bare selling-unit
// qty for a boxed pack line.
const CHANGE_QTY_CR = {
  id: "cr-2",
  orderId: "ord-1",
  orderItemId: "item-1",
  productId: "prod-1",
  type: "CHANGE_QTY" as const,
  status: "PENDING" as const,
  payload: { orderItemId: "item-1", newQty: 75 },
  note: null,
  requestedById: "user-op",
  requestedByName: "operator1",
  requestedByRole: "OPERATOR",
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
        {
          provide: SellingRestrictionsService,
          useValue: {
            restrictedProductIdsFor: jest.fn().mockResolvedValue(new Set<string>()),
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
          },
        },
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
      prisma.product.findFirst.mockResolvedValue({ ...VISIBLE_TOMATOES });
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
      prisma.product.findFirst.mockResolvedValue({ ...VISIBLE_TOMATOES });
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

    // B1135 / SA-696: a SHIP (carrier) order has no route run, so the G7 inverse gate answered
    // EDIT_WINDOW_OPEN ("use PATCH /orders/:id/items") while that PATCH sent the buyer back here. A
    // with-carrier order's lines are frozen, so a change request on it gets its own coded refusal.
    describe("B1135: an order with the carrier (SHIP, no route run)", () => {
      const SHIPPED_MESSAGE = "This order has already shipped. Contact the seller for changes.";
      const withCarrier = {
        ...dispatchedOrder,
        tenantId: "test-tenant",
        fulfillPath: "SHIP" as const,
        shippedAt: new Date("2026-10-01T00:00:00Z"),
        routeRunId: null,
        routeRunStopId: null,
        routeRun: null,
      };
      const shipBillingTenant = (mode: string) => {
        (ordersService as any).featureConfig = {
          getEffectiveMode: jest.fn().mockResolvedValue(mode),
        };
      };

      it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED"] as const)(
        "a %s order with the carrier: 409 with the new code and message, nothing filed",
        async (status) => {
          shipBillingTenant("ship");
          prisma.order.findUnique.mockResolvedValue({ ...withCarrier, status });
          prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });

          const attempt = service.create(
            "ord-1",
            { type: "NOTE" as any, note: "add a case please" },
            customerUser,
          );

          await expect(attempt).rejects.toBeInstanceOf(ConflictException);
          await expect(attempt).rejects.toMatchObject({
            response: {
              code: API_ERROR_CODES.ORDER_WITH_CARRIER_NO_CHANGE_REQUEST,
              message: SHIPPED_MESSAGE,
            },
          });
          expect(prisma.changeRequest.create).not.toHaveBeenCalled();
          expect(messaging.notifyEvent).not.toHaveBeenCalled();
        },
      );

      it("the staff caller gets the same answer (the order, not the role, decides)", async () => {
        shipBillingTenant("both");
        prisma.order.findUnique.mockResolvedValue(withCarrier);

        await expect(
          service.create("ord-1", { type: "NOTE" as any, note: "hi" }, operatorUser),
        ).rejects.toMatchObject({
          response: { code: API_ERROR_CODES.ORDER_WITH_CARRIER_NO_CHANGE_REQUEST },
        });
      });

      it("a CUSTOMER who does not own the order still meets the bare 403, never the shipped message", async () => {
        shipBillingTenant("ship");
        prisma.order.findUnique.mockResolvedValue(withCarrier);
        prisma.customer.findFirst.mockResolvedValue({ id: "cust-OTHER" });

        await expect(
          service.create("ord-1", { type: "NOTE" as any, note: "hi" }, customerUser),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it("a route-run order is unchanged: an IN_PROGRESS run still files the request", async () => {
        shipBillingTenant("ship");
        prisma.order.findUnique.mockResolvedValue({ ...dispatchedOrder, fulfillPath: "ROUTE" });
        prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
        prisma.changeRequest.create.mockResolvedValue({ id: "cr-new", status: "PENDING" });

        await service.create("ord-1", { type: "NOTE" as any, note: "leave at back" }, customerUser);

        expect(prisma.changeRequest.create).toHaveBeenCalledTimes(1);
      });

      it("a route-run order is unchanged: a SCHEDULED run still answers EDIT_WINDOW_OPEN", async () => {
        shipBillingTenant("ship");
        prisma.order.findUnique.mockResolvedValue({
          ...dispatchedOrder,
          fulfillPath: "ROUTE",
          status: "CONFIRMED",
          routeRun: { status: "SCHEDULED" },
        });

        await expect(
          service.create("ord-1", { type: "NOTE" as any, note: "hi" }, operatorUser),
        ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.EDIT_WINDOW_OPEN } });
      });

      it("a business that does not bill at shipment keeps today's EDIT_WINDOW_OPEN (the guard is gated on it)", async () => {
        shipBillingTenant("pickup");
        prisma.order.findUnique.mockResolvedValue(withCarrier);

        await expect(
          service.create("ord-1", { type: "NOTE" as any, note: "hi" }, operatorUser),
        ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.EDIT_WINDOW_OPEN } });
      });
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
        // row 510: the resolve body rides along, so the office's acknowledgement of a restriction warning reaches the gate
        expect.objectContaining({ action: ChangeRequestResolveAction.APPROVE_AT_STOP }),
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
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        trackedCategoryId: null,
        // portal-visible: a buyer-requested add is re-judged on the buyer channel at approval (F1 iii)
        kind: "STANDARD",
        isActive: true,
        portalVisible: true,
        parent: null,
      });
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
        // REG-B142-G: this draft path is the one exempt caller — it must
        // pass allowArchived so a since-archived line can still roll over.
        {
          skipAutoMerge: false,
          allowArchived: true,
          internalCustomerDraft: true,
          lineAuthor: "BUYER", // SA ruling #3418: PENDING_CR was filed by a CUSTOMER
        },
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

    // B655: rolling a CHANGE_QTY delta to the next delivery re-created the line through create()
    // with a bare qty. For a BOX-AWARE line (li.boxes != null), OrderItem.qty is TOTAL PIECES, so
    // that bare qty is a pieces delta re-read by create() as SELLING UNITS (boxes) — a 51-piece
    // delta on a 24-pack product posted as 51 boxes (1,224 pieces) at the live price instead of
    // 2 boxes + 3 pieces.
    it("splits a box-aware CHANGE_QTY line's pieces delta using its own unitsPerBox snapshot (B655)", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(CHANGE_QTY_CR);
      prisma.orderItem.findFirst.mockResolvedValue({
        id: "item-1",
        productId: "prod-1",
        qty: 24, // total pieces (1 box of 24)
        boxes: 1,
        pieces: 0,
        unitsPerBox: 24,
        unitLabel: null,
        status: "PENDING",
      });
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        trackedCategoryId: null,
        // portal-visible: a buyer-requested add is re-judged on the buyer channel at approval (F1 iii)
        kind: "STANDARD",
        isActive: true,
        portalVisible: true,
        parent: null,
      });

      await service.resolve(
        "ord-1",
        "cr-2",
        { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
        operatorUser,
      );

      // delta = 75 - 24 = 51 pieces; upb 24 -> 2 boxes + 3 pieces (51 = 2*24 + 3).
      expect(ordersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ productId: "prod-1", qty: 51, boxes: 2, pieces: 3 })],
        }),
        expect.anything(),
        expect.anything(),
      );
      // Never re-derived from the live product — an existing line's rewrite uses only what the
      // line itself stored (SA ruling).
      expect(prisma.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ select: { id: true, trackedCategoryId: true } }),
      );
    });

    // A box-aware line whose unitsPerBox snapshot predates the column (null) derives the pack
    // EXACTLY from its own stored split — (qty - pieces) / boxes — never from the live product.
    it("derives a box-aware line's pack from its own stored split when the snapshot is null", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(CHANGE_QTY_CR);
      prisma.orderItem.findFirst.mockResolvedValue({
        id: "item-1",
        productId: "prod-1",
        qty: 24, // (24 - 0) / 1 = 24
        boxes: 1,
        pieces: 0,
        unitsPerBox: null,
        unitLabel: null,
        status: "PENDING",
      });
      // The live product's pack, if it were read, would derive a DIFFERENT (wrong) split —
      // proves the derivation never touches it.
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        trackedCategoryId: null,
        // portal-visible: a buyer-requested add is re-judged on the buyer channel at approval (F1 iii)
        kind: "STANDARD",
        isActive: true,
        portalVisible: true,
        parent: null,
      });

      await service.resolve(
        "ord-1",
        "cr-2",
        { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
        operatorUser,
      );

      expect(ordersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ productId: "prod-1", qty: 51, boxes: 2, pieces: 3 })],
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    // No snapshot AND no derivable pack (boxes: 0 — nothing to divide by) refuses rather than
    // guessing at a factor.
    it("refuses a box-aware line whose pack can't be derived, naming the line", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(CHANGE_QTY_CR);
      prisma.orderItem.findFirst.mockResolvedValue({
        id: "item-1",
        productId: "prod-1",
        qty: 5,
        boxes: 0,
        pieces: 5,
        unitsPerBox: null,
        unitLabel: null,
        status: "PENDING",
      });
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        trackedCategoryId: null,
        // portal-visible: a buyer-requested add is re-judged on the buyer channel at approval (F1 iii)
        kind: "STANDARD",
        isActive: true,
        portalVisible: true,
        parent: null,
      });

      await expect(
        service.resolve(
          "ord-1",
          "cr-2",
          { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
          operatorUser,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "LINE_PACK_UNDERIVABLE",
          message: expect.stringContaining("item-1"),
        }),
      });
      expect(ordersService.create).not.toHaveBeenCalled();
    });

    // A snapshot of 0 (or 1) is not a real pack — the "not case-packed" value, not a genuine
    // factor. It must fall through to deriving from the line's own stored split exactly like a
    // null snapshot, never reach normalizeBoxesPieces' non-boxed branch (which would post the
    // pieces delta as a bare qty — the original B655 shape).
    it("treats a box-aware line's unitsPerBox: 0 snapshot as absent and derives from its own split", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(CHANGE_QTY_CR);
      prisma.orderItem.findFirst.mockResolvedValue({
        id: "item-1",
        productId: "prod-1",
        qty: 24, // (24 - 0) / 1 = 24
        boxes: 1,
        pieces: 0,
        unitsPerBox: 0,
        unitLabel: null,
        status: "PENDING",
      });
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        trackedCategoryId: null,
        // portal-visible: a buyer-requested add is re-judged on the buyer channel at approval (F1 iii)
        kind: "STANDARD",
        isActive: true,
        portalVisible: true,
        parent: null,
      });

      await service.resolve(
        "ord-1",
        "cr-2",
        { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
        operatorUser,
      );

      expect(ordersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ productId: "prod-1", qty: 51, boxes: 2, pieces: 3 })],
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    // Control: a plain non-boxed line's rolled delta is a bare qty, unaffected — no boxes/pieces
    // keys added.
    it("does not split a non-boxed CHANGE_QTY line's delta (control)", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue({
        ...CHANGE_QTY_CR,
        payload: { orderItemId: "item-1", newQty: 10 },
      });
      prisma.orderItem.findFirst.mockResolvedValue({
        id: "item-1",
        productId: "prod-1",
        qty: 5,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitLabel: null,
        status: "PENDING",
      });
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        trackedCategoryId: null,
        // portal-visible: a buyer-requested add is re-judged on the buyer channel at approval (F1 iii)
        kind: "STANDARD",
        isActive: true,
        portalVisible: true,
        parent: null,
      });

      await service.resolve(
        "ord-1",
        "cr-2",
        { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
        operatorUser,
      );

      expect(ordersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ items: [{ productId: "prod-1", qty: 5 }] }),
        expect.anything(),
        expect.anything(),
      );
    });

    // SA's exact under-charge example: a BOX-UNAWARE line's qty IS ALREADY the box count (no
    // split stored), so its delta must post as bare boxes — splitting it against ANY pack (even
    // the line's own unitsPerBox) would misread a boxes delta as pieces. A 3-box delta split
    // against upb 24 would become 0 boxes + 3 pieces: an under-charge, not a fix.
    it("keeps a box-unaware BOXED line's delta as bare boxes — never splits it against a pack", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue({
        ...CHANGE_QTY_CR,
        payload: { orderItemId: "item-1", newQty: 5 }, // 5 boxes total
      });
      prisma.orderItem.findFirst.mockResolvedValue({
        id: "item-1",
        productId: "prod-1",
        qty: 2, // 2 boxes (box-unaware convention — no boxes/pieces split stored)
        boxes: null,
        pieces: null,
        unitsPerBox: 24, // present on the line, but must never be used to split this shape
        unitLabel: null,
        status: "PENDING",
      });
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        trackedCategoryId: null,
        // portal-visible: a buyer-requested add is re-judged on the buyer channel at approval (F1 iii)
        kind: "STANDARD",
        isActive: true,
        portalVisible: true,
        parent: null,
      });

      await service.resolve(
        "ord-1",
        "cr-2",
        { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
        operatorUser,
      );

      // delta = 5 - 2 = 3 boxes; must stay a bare qty:3, never {qty, boxes:0, pieces:3}.
      expect(ordersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ items: [{ productId: "prod-1", qty: 3 }] }),
        expect.anything(),
        expect.anything(),
      );
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
      // SA-434: the SA-429 predicate reads the ORDER's own stop chain (not order.routeRun).
      prisma.order.findFirst.mockResolvedValue({ routeRunStopId: "stop-1" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        status: "PENDING",
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
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

  // ─── B673: a door ADD_ITEM's box split must survive a next-delivery rollover ─────────────────

  /**
   * B673 (REG-B673). A driver adding 1 box of a 12-pack at the door files the ADD_ITEM as
   * `{ qty: 12 (total pieces), boxes: 1, pieces: 0 }`. `approveNextDelivery` used to read only the
   * bare `qty` and hand `{ productId, qty: 12 }` to `OrdersService.create()`, which — by house
   * convention — reads a bare qty on a boxed product as a BOX count: 12 boxes, billed $480 for $40.
   *
   * The buyer portal files the other shape — a bare `qty` in selling units (boxes), no split — and
   * that path must stay byte-identical. So the fix branches on "a split is present", never on who
   * filed the request, and never reinterprets a bare qty.
   *
   * Harness: `create()` is replaced by a boundary fake that prices each item EXACTLY as create()
   * does — its own split predicate (`orders.service.ts` ~:1995), `normalizeBoxesPieces`, then the
   * real `computeLineSubtotal` from @routeflow/pricing at the $40 box price and the LIVE pack — and
   * returns that as the draft's total. The service passes `Number(draft.total)` on to the credit
   * re-check, so the billed figure is read where the service itself reads it. A plain jest.fn()
   * here would hide the price entirely, which is how this shipped.
   */
  describe("B673 — APPROVE_NEXT_DELIVERY of an ADD_ITEM carrying a box split (REG-B673)", () => {
    const BOX_PRICE = 40;
    let livePack = 12;

    /** What create() bills for one item: its split predicate, normalizeBoxesPieces, then pricing. */
    const priceLikeCreate = (item: {
      qty: number;
      boxes?: number | null;
      pieces?: number | null;
    }): number => {
      let qty = item.qty;
      let boxes: number | null = null;
      let pieces: number | null = null;
      if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0) {
        const split = normalizeBoxesPieces({
          boxes: item.boxes,
          pieces: item.pieces,
          qty: item.qty,
          unitsPerBox: livePack,
        });
        qty = split.qty;
        boxes = split.boxes;
        pieces = split.pieces;
      }
      return computeLineSubtotal({
        unitPrice: BOX_PRICE,
        qty,
        boxes,
        pieces,
        unitsPerBox: livePack,
      });
    };

    /** The draft total the service passed on to the credit re-check — i.e. what was billed. */
    const billed = (): number => ordersService.assertCreditForProjectedOrder.mock.calls[0][2];
    const createdItems = () => ordersService.create.mock.calls[0][0].items;

    const doorAdd = (payload: Record<string, unknown>) => ({
      ...PENDING_CR,
      requestedById: "user-drv",
      requestedByName: "driver1",
      requestedByRole: "DRIVER",
      payload: { productId: "prod-1", productName: "Sample Cola 12pk", ...payload },
    });

    const approveNextDelivery = () =>
      service.resolve(
        "ord-1",
        "cr-1",
        { action: ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY },
        operatorUser,
      );

    beforeEach(() => {
      livePack = 12;
      prisma.order.findUnique.mockResolvedValue({
        ...dispatchedOrder,
        routeRun: { driverId: "drv-1", status: "IN_PROGRESS" },
      });
      prisma.product.findFirst.mockImplementation(async () => ({
        id: "prod-1",
        name: "Sample Cola 12pk",
        trackedCategoryId: null,
        unitsPerBox: livePack,
        // portal-visible: a buyer-requested add is re-judged on the buyer channel at approval (F1 iii)
        kind: "STANDARD",
        isActive: true,
        portalVisible: true,
        parent: null,
      }));
      prisma.customer.findFirst.mockResolvedValue({ userId: "user-cust" });
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.changeRequest.findUnique.mockResolvedValue({ ...PENDING_CR, status: "APPROVED" });
      ordersService.create.mockImplementation(async (dto: { items: any[] }) => ({
        id: "draft-1",
        total: dto.items.reduce((sum, item) => sum + priceLikeCreate(item), 0),
      }));
    });

    it("REG-B673-1: 1 box of a 12-pack at $40 is billed $40, not $480 (12 boxes)", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(doorAdd({ qty: 12, boxes: 1, pieces: 0 }));

      await approveNextDelivery();

      expect(billed()).toBe(40);
      expect(createdItems()).toEqual([{ productId: "prod-1", qty: 12, boxes: 1, pieces: 0 }]);
    });

    it("REG-B673-4: 5 loose pieces of a 12-pack are billed $16.67, not $200 (5 boxes)", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue(doorAdd({ qty: 5, boxes: 0, pieces: 5 }));

      await approveNextDelivery();

      expect(billed()).toBe(16.67);
      expect(createdItems()).toEqual([{ productId: "prod-1", qty: 5, boxes: 0, pieces: 5 }]);
    });

    it("REG-B673-2: the pack changed since filing (12 → 6) — refused, naming BOTH packs; nothing drafted, CR stays PENDING", async () => {
      livePack = 6;
      prisma.changeRequest.findFirst.mockResolvedValue(doorAdd({ qty: 12, boxes: 1, pieces: 0 }));

      const err = await approveNextDelivery().catch((e) => e);

      expect(ordersService.create).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(BadRequestException);
      const body = err.getResponse();
      expect(body.code).toBe("CHANGE_REQUEST_PACK_CHANGED");
      expect(body.message).toContain("12 per box");
      expect(body.message).toContain("6 per box");
      expect(body.message).toContain("Sample Cola 12pk");
      // The advice: decline and re-add on the next order. Never approve-at-stop — the item was not
      // on the truck, and that path's merge re-prices at 12x on an old box-unaware line (B753(a)).
      expect(body.message).toContain("Decline it and re-add the item to the next order");
      expect(body.message).not.toMatch(/approve at stop/i);
      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
    });

    it("REG-B673-3: the product is no longer sold by the box — refused, naming the filed pack; nothing drafted", async () => {
      livePack = 1;
      prisma.changeRequest.findFirst.mockResolvedValue(doorAdd({ qty: 12, boxes: 1, pieces: 0 }));

      const err = await approveNextDelivery().catch((e) => e);

      expect(ordersService.create).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(BadRequestException);
      const body = err.getResponse();
      expect(body.code).toBe("CHANGE_REQUEST_PACK_CHANGED");
      expect(body.message).toContain("12 per box");
      expect(body.message).toContain("no longer sold by the box");
      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
    });

    it("REG-B673-3b: a filed pack that disagrees with the live one (1 box = 11 pieces vs 12) is a pack mismatch — refused, never billed", async () => {
      // `(qty - pieces) / boxes` is the only record of the pack at filing; 11 is a valid pack, so
      // this reads as "filed at 11 per box" and is refused naming both packs, like any pack change.
      prisma.changeRequest.findFirst.mockResolvedValue(doorAdd({ qty: 11, boxes: 1, pieces: 0 }));

      const err = await approveNextDelivery().catch((e) => e);

      expect(ordersService.create).not.toHaveBeenCalled();
      expect(err.getResponse().code).toBe("CHANGE_REQUEST_PACK_CHANGED");
      expect(err.getResponse().message).toContain("11 per box");
      expect(err.getResponse().message).toContain("12 per box");
    });

    it.each([
      ["negative boxes", { qty: 12, boxes: -1, pieces: 0 }],
      ["fractional boxes", { qty: 12, boxes: 1.5, pieces: 0 }],
      ["negative pieces", { qty: 12, boxes: 1, pieces: -1 }],
      ["an all-zero split", { qty: 12, boxes: 0, pieces: 0 }],
      ["more loose pieces than the qty", { qty: 3, boxes: 0, pieces: 5 }],
      ["a pack that is not a whole number", { qty: 13, boxes: 2, pieces: 0 }],
    ])(
      "REG-B673-5: an inconsistent split (%s) is refused as INVALID_LINE_SPLIT — never reinterpreted, never billed",
      async (_label, payload) => {
        prisma.changeRequest.findFirst.mockResolvedValue(doorAdd(payload));

        const err = await approveNextDelivery().catch((e) => e);

        expect(ordersService.create).not.toHaveBeenCalled();
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse().code).toBe("INVALID_LINE_SPLIT");
      },
    );

    it("PIN-B673-1: the buyer's bare qty (boxes, no split) is untouched — create() gets exactly { productId, qty }", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue({
        ...PENDING_CR,
        payload: { productId: "prod-1", qty: 3, productName: "Sample Cola 12pk" },
      });

      await approveNextDelivery();

      expect(createdItems()).toEqual([{ productId: "prod-1", qty: 3 }]);
      expect(Object.keys(createdItems()[0])).toEqual(["productId", "qty"]);
      expect(billed()).toBe(120); // 3 boxes at $40
    });

    it("PIN-B673-1b: a buyer's bare 1 (box) is still $40", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue({
        ...PENDING_CR,
        payload: { productId: "prod-1", qty: 1, productName: "Sample Cola 12pk" },
      });

      await approveNextDelivery();

      expect(createdItems()).toEqual([{ productId: "prod-1", qty: 1 }]);
      expect(billed()).toBe(40);
    });

    it("PIN-B673-1c: an explicit null split (how the create path stores a buyer request) is still a bare qty", async () => {
      prisma.changeRequest.findFirst.mockResolvedValue({
        ...PENDING_CR,
        payload: {
          productId: "prod-1",
          qty: 2,
          boxes: null,
          pieces: null,
          productName: "Sample Cola 12pk",
        },
      });

      await approveNextDelivery();

      expect(createdItems()).toEqual([{ productId: "prod-1", qty: 2 }]);
      expect(billed()).toBe(80);
    });
  });
});
