import { Test } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";

import { ChangeRequestsService } from "./change-requests.service";
import { OrdersService } from "./orders.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * F1(iii): a BUYER filing an ADD_ITEM change request goes through the buyer visibility gate
 * (`isBuyerVisibleProduct`) and the selling-restrictions choke point on the BUYER_PORTAL channel, at FILING
 * time, not only when staff approve. A product the portal hides is a 404 in the same shape as every other
 * hidden-product 404 (no product name, nothing about why). A driver's door add keeps the staff posture.
 */
const base = { status: "ACTIVE" as const, forcePasswordChange: false, tenantId: "test-tenant" };
const customerUser = {
  ...base,
  sub: "user-cust",
  username: "buyer1",
  role: "CUSTOMER",
} as JwtPayload;
const driverUser = { ...base, sub: "user-drv", username: "driver1", role: "DRIVER" } as JwtPayload;

const dispatchedOrder = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-100",
  total: 16.47,
  status: "OUT_FOR_DELIVERY" as const,
  routeRunId: "run-1",
  routeRunStopId: "stop-1",
  lineItems: [],
  routeRun: { status: "IN_PROGRESS" as const },
};

const SECRET = "Secret Soda";
const product = (over: Record<string, unknown> = {}) => ({
  id: "prod-1",
  name: SECRET,
  isActive: true,
  kind: "STANDARD",
  portalVisible: true,
  parent: null,
  ...over,
});

describe("ChangeRequestsService.create: ADD_ITEM filing and buyer visibility (F1 iii)", () => {
  let service: ChangeRequestsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let restrictions: {
    restrictedProductIdsFor: jest.Mock;
    assertLinesSellable: jest.Mock;
    checkLinesSellable: jest.Mock;
    getPolicy: jest.Mock;
  };
  const file = (user: JwtPayload) =>
    service.create("ord-1", { type: "ADD_ITEM" as never, productId: "prod-1", qty: 3 }, user);

  beforeEach(async () => {
    prisma = createMockPrisma();
    restrictions = {
      restrictedProductIdsFor: jest.fn().mockResolvedValue(new Set<string>()),
      assertLinesSellable: jest.fn().mockResolvedValue(undefined),
      checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
      getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
    };
    const module = await Test.createTestingModule({
      providers: [
        ChangeRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrdersService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: SellingRestrictionsService, useValue: restrictions },
      ],
    }).compile();
    service = module.get(ChangeRequestsService);
    prisma.order.findUnique.mockResolvedValue(dispatchedOrder);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.changeRequest.create.mockResolvedValue({ id: "cr-new", status: "PENDING" });
  });

  const expectHidden404 = async (user: JwtPayload = customerUser) => {
    const err = await file(user).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect(JSON.stringify(err.getResponse())).not.toContain(SECRET);
    expect(JSON.stringify(err.getResponse())).not.toContain("prod-1");
    expect(prisma.changeRequest.create).not.toHaveBeenCalled();
  };

  it("a portal-hidden product is a 404 with no product name, and nothing is filed", async () => {
    prisma.product.findFirst.mockResolvedValue(product({ portalVisible: false }));
    await expectHidden404();
  });

  it("a product the restrictions engine hides from THIS buyer is the same 404", async () => {
    prisma.product.findFirst.mockResolvedValue(product());
    restrictions.restrictedProductIdsFor.mockResolvedValue(new Set(["prod-1"]));
    await expectHidden404();
  });

  it("a product under a hidden parent is the same 404", async () => {
    prisma.product.findFirst.mockResolvedValue(
      product({ parent: { portalVisible: false, isActive: true, tenantId: "test-tenant" } }),
    );
    await expectHidden404();
  });

  it("a hidden FAMILY product is the same 404, not a 400 that names it", async () => {
    prisma.product.findFirst.mockResolvedValue(product({ kind: "FAMILY", portalVisible: false }));
    await expectHidden404();
  });

  it("a nonexistent product and a hidden one are indistinguishable (same status and body)", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    const missing = await file(customerUser).catch((e) => e);
    prisma.product.findFirst.mockResolvedValue(product({ portalVisible: false }));
    const hidden = await file(customerUser).catch((e) => e);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(hidden).toBeInstanceOf(NotFoundException);
    expect(missing.getResponse()).toEqual(hidden.getResponse());
  });

  it("control: a DRIVER's door add of a nonexistent product keeps its 400", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(file(driverUser)).rejects.toMatchObject({ status: 400 });
  });

  it("control: a visible, allowed product files, judged on the BUYER_PORTAL channel", async () => {
    prisma.product.findFirst.mockResolvedValue(product());

    await file(customerUser);

    expect(prisma.changeRequest.create).toHaveBeenCalledTimes(1);
    expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "test-tenant",
        customerId: "cust-1",
        lines: [{ productId: "prod-1" }],
        channel: "BUYER_PORTAL",
      }),
    );
  });

  it("a banned-but-visible product (the engine's 409) refuses filing and files nothing", async () => {
    prisma.product.findFirst.mockResolvedValue(product());
    restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] }),
    );

    await expect(file(customerUser)).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    expect(prisma.changeRequest.create).not.toHaveBeenCalled();
  });

  it("control: a DRIVER's door add of a portal-hidden product still files (staff posture, not a buyer filing)", async () => {
    prisma.product.findFirst.mockResolvedValue(product({ portalVisible: false }));

    await file(driverUser);

    expect(prisma.changeRequest.create).toHaveBeenCalledTimes(1);
    expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
  });
});
