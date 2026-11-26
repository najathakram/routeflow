import { Test } from "@nestjs/testing";

import { ChangeRequestsService } from "./change-requests.service";
import { OrdersService } from "./orders.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BUYER_LINE_QTY_OVER_MAX_MESSAGE } from "./buyer-line-cap";

/**
 * B1386: a CUSTOMER change request (ADD_ITEM or CHANGE_QTY) whose resolved piece total passes
 * BUYER_LINE_QTY_MAX (100,000) is refused at filing, nothing created. Rise-only for CHANGE_QTY; staff are
 * never capped.
 */
const base = { status: "ACTIVE" as const, forcePasswordChange: false, tenantId: "test-tenant" };
const customerUser = {
  ...base,
  sub: "user-cust",
  username: "buyer1",
  role: "CUSTOMER",
} as JwtPayload;
const operatorUser = {
  ...base,
  sub: "user-op",
  username: "operator1",
  role: "OPERATOR",
} as JwtPayload;

const OVER = {
  response: {
    code: API_ERROR_CODES.BUYER_LINE_QTY_OVER_MAX,
    message: BUYER_LINE_QTY_OVER_MAX_MESSAGE,
  },
};

const orderWith = (lineItems: Array<Record<string, unknown>>) => ({
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-100",
  total: 16.47,
  status: "OUT_FOR_DELIVERY" as const,
  routeRunId: "run-1",
  routeRunStopId: "stop-1",
  lineItems,
  routeRun: { status: "IN_PROGRESS" as const },
});
const storedLine = (over: Record<string, unknown> = {}) => ({
  id: "item-1",
  productId: "prod-1",
  status: "PENDING",
  qty: 10,
  boxes: null,
  pieces: null,
  ...over,
});
const visibleProduct = {
  id: "prod-1",
  name: "Acme Soda",
  isActive: true,
  kind: "STANDARD",
  portalVisible: true,
  parent: null,
};

describe("ChangeRequestsService.create buyer line cap (B1386)", () => {
  let service: ChangeRequestsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const restrictions = {
      restrictedProductIdsFor: jest.fn().mockResolvedValue(new Set<string>()),
      assertLinesSellable: jest.fn().mockResolvedValue(undefined),
      checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
      getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
    };
    const module = await Test.createTestingModule({
      providers: [
        ChangeRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrdersService, useValue: { create: jest.fn() } },
        { provide: NotificationsService, useValue: {} },
        {
          provide: AuthorizationGuardService,
          useValue: { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: SellingRestrictionsService, useValue: restrictions },
      ],
    }).compile();
    service = module.get(ChangeRequestsService);
    prisma.order.findUnique.mockResolvedValue(orderWith([storedLine()]));
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", userId: "user-cust" });
    prisma.product.findFirst.mockResolvedValue(visibleProduct);
    prisma.changeRequest.create.mockResolvedValue({ id: "cr-new", status: "PENDING" });
  });

  /** The live pack, as `loadLiveUnitsPerBoxByProduct` reads it: product.findMany({ id, unitsPerBox }). */
  const livePack = (upb: number) =>
    prisma.product.findMany.mockResolvedValue([{ id: "prod-1", unitsPerBox: upb }]);

  describe("REG-B1386 change request cap", () => {
    it("C1 refuses a CUSTOMER ADD_ITEM of 100,001 pieces on a plain product", async () => {
      livePack(0);
      await expect(
        service.create(
          "ord-1",
          { type: "ADD_ITEM" as never, productId: "prod-1", qty: 100_001 },
          customerUser,
        ),
      ).rejects.toMatchObject(OVER);
      expect(prisma.changeRequest.create).not.toHaveBeenCalled();
    });

    it("C2 refuses a CUSTOMER CHANGE_QTY whose packs x live pack pass the cap (8,334 x 12)", async () => {
      livePack(12);
      prisma.order.findUnique.mockResolvedValue(orderWith([storedLine({ qty: 10 })]));
      await expect(
        service.create(
          "ord-1",
          { type: "CHANGE_QTY" as never, orderItemId: "item-1", qty: 8_334 },
          customerUser,
        ),
      ).rejects.toMatchObject(OVER);
      expect(prisma.changeRequest.create).not.toHaveBeenCalled();
    });

    it("C3 refuses a CUSTOMER ADD_ITEM filed as a split of 100,001 pieces", async () => {
      livePack(12);
      await expect(
        service.create(
          "ord-1",
          {
            type: "ADD_ITEM" as never,
            productId: "prod-1",
            qty: 100_001,
            boxes: 8_333,
            pieces: 5,
          },
          customerUser,
        ),
      ).rejects.toMatchObject(OVER);
      expect(prisma.changeRequest.create).not.toHaveBeenCalled();
    });
  });

  describe("REG-B1386 change request cap (box-split)", () => {
    it("C4 refuses a CUSTOMER CHANGE_QTY to 100,001 pieces on a stored box-split line", async () => {
      livePack(12);
      prisma.order.findUnique.mockResolvedValue(
        orderWith([storedLine({ qty: 24, boxes: 2, pieces: 0 })]),
      );
      await expect(
        service.create(
          "ord-1",
          { type: "CHANGE_QTY" as never, orderItemId: "item-1", qty: 100_001 },
          customerUser,
        ),
      ).rejects.toMatchObject(OVER);
      expect(prisma.changeRequest.create).not.toHaveBeenCalled();
    });
  });

  describe("change request cap pins (B1386)", () => {
    it("P12 CUSTOMER REMOVE_ITEM and NOTE on an order holding a 120,000 line are created", async () => {
      livePack(0);
      prisma.order.findUnique.mockResolvedValue(orderWith([storedLine({ qty: 120_000 })]));
      await service.create(
        "ord-1",
        { type: "REMOVE_ITEM" as never, orderItemId: "item-1" },
        customerUser,
      );
      await service.create(
        "ord-1",
        { type: "NOTE" as never, note: "Leave at the dock" },
        customerUser,
      );
      expect(prisma.changeRequest.create).toHaveBeenCalledTimes(2);
    });

    it("P2c staff (OPERATOR) ADD_ITEM of 240,000 is created", async () => {
      livePack(0);
      await service.create(
        "ord-1",
        { type: "ADD_ITEM" as never, productId: "prod-1", qty: 240_000 },
        operatorUser,
      );
      expect(prisma.changeRequest.create).toHaveBeenCalledTimes(1);
    });

    it("P6c CUSTOMER CHANGE_QTY lowering a stored 120,000-piece line to 110,000 is created (rise-only)", async () => {
      livePack(0);
      prisma.order.findUnique.mockResolvedValue(orderWith([storedLine({ qty: 120_000 })]));
      await service.create(
        "ord-1",
        { type: "CHANGE_QTY" as never, orderItemId: "item-1", qty: 110_000 },
        customerUser,
      );
      expect(prisma.changeRequest.create).toHaveBeenCalledTimes(1);
    });

    it("P7c CUSTOMER ADD_ITEM of 8,333 packs of 12 (99,996 pieces) is created", async () => {
      livePack(12);
      await service.create(
        "ord-1",
        { type: "ADD_ITEM" as never, productId: "prod-1", qty: 8_333 },
        customerUser,
      );
      expect(prisma.changeRequest.create).toHaveBeenCalledTimes(1);
    });
  });
});
