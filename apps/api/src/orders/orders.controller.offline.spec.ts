// SA-1124 PR-1a rows B5-B7: the `offline` create mode at the controller (role, money, quote and open-order rules).
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { OrdersController } from "./orders.controller";
import { OrderBatchShipService } from "./order-batch-ship";
import { PackingSlipService } from "./packing-slip.service";
import { StockAvailabilityService } from "./stock-availability.service";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const payload = (role: string): JwtPayload =>
  ({
    sub: `user-${role}`,
    username: role.toLowerCase(),
    role,
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: null,
    tenantSlug: null,
  }) as JwtPayload;

const quote = {
  total: 10,
  lines: [{ index: 0, unitPrice: 10, unitsPerBox: null, unitLabel: null }],
};
const body = (extra: Record<string, unknown> = {}) =>
  ({
    customerId: "cust-1",
    items: [{ productId: "prod-1", qty: 1 }],
    ...extra,
  }) as any;
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { status: e.getStatus?.(), code: e.getResponse?.()?.code, message: e.message };
  }
  return null;
};

describe("OrdersController.create - the offline mode (SA-1124 PR-1a)", () => {
  let controller: OrdersController;
  let ordersService: Record<string, jest.Mock> & { prisma: unknown };
  const activeOrder = {
    id: "ord-open",
    orderNumber: "ORD-00009",
    status: "PENDING",
    total: 10,
    createdAt: new Date(),
    lineItems: [{ productId: "prod-1", qty: 2, unitPrice: 5, priceType: "MANUAL", name: null }],
  };

  beforeEach(async () => {
    ordersService = {
      findActiveOrder: jest.fn().mockResolvedValue(activeOrder),
      liveTrioByProduct: jest.fn().mockResolvedValue(new Map()),
      liveUnitsPerBoxByProduct: jest.fn().mockResolvedValue(new Map()),
      updateOrderItems: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(activeOrder),
      create: jest.fn().mockResolvedValue({ id: "ord-new", customerId: "cust-1" }),
      prisma: {
        user: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 1 }),
        },
      },
    } as never;
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: OrdersService, useValue: ordersService },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: OrderBatchShipService, useValue: {} },
        { provide: PackingSlipService, useValue: {} },
        { provide: StockAvailabilityService, useValue: {} },
      ],
    }).compile();
    controller = module.get<OrdersController>(OrdersController);
  });

  describe("B5: an open order exists", () => {
    it("master: without offline the staff gets 409 MERGE_CHOICE_REQUIRED and nothing is created", async () => {
      const res = await codeOf(controller.create(body(), payload("OPERATOR")));
      expect(res).toMatchObject({ status: 409, code: "MERGE_CHOICE_REQUIRED" });
      expect(ordersService.create).not.toHaveBeenCalled();
    });

    it("offline: never asks, never merges; creates separately and hands the open order's id to create()", async () => {
      await controller.create(
        body({ offline: true, offlineQuote: quote, offlineCreatedAt: "2026-11-07T15:00:00.000Z" }),
        payload("OPERATOR"),
      );
      expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
      expect(ordersService.mergeAllPendingForCustomer).not.toHaveBeenCalled();
      expect(ordersService.create).toHaveBeenCalledTimes(1);
      const [dto, , options] = ordersService.create.mock.calls[0];
      expect(options).toMatchObject({
        skipAutoMerge: true,
        offline: {
          openOrderId: "ord-open",
          createdAt: new Date("2026-11-07T15:00:00.000Z"),
          quote,
        },
      });
      expect(dto.customerId).toBe("cust-1");
    });

    it("offline ignores an explicit mergeChoice of merge: the open order is untouched", async () => {
      await controller.create(
        body({ offline: true, offlineQuote: quote, mergeChoice: "merge" }),
        payload("OPERATOR"),
      );
      expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
      expect(ordersService.create).toHaveBeenCalledTimes(1);
    });

    it("offline with no open order: openOrderId is null", async () => {
      ordersService.findActiveOrder.mockResolvedValue(null);
      await controller.create(body({ offline: true, offlineQuote: quote }), payload("OPERATOR"));
      expect(ordersService.create.mock.calls[0][2]).toMatchObject({
        offline: { openOrderId: null, createdAt: null },
      });
    });

    it("an Idempotency-Key header still reaches create() on the DTO", async () => {
      await controller.create(
        body({ offline: true, offlineQuote: quote }),
        payload("OPERATOR"),
        "key-1",
      );
      expect(ordersService.create.mock.calls[0][0].idempotencyKey).toBe("key-1");
    });

    it("TENANT_ADMIN is accepted like OPERATOR", async () => {
      await controller.create(
        body({ offline: true, offlineQuote: quote }),
        payload("TENANT_ADMIN"),
      );
      expect(ordersService.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("B6: staff only", () => {
    it.each(["CUSTOMER", "DRIVER"])(
      "%s with offline:true gets 403 OFFLINE_STAFF_ONLY before any merge logic",
      async (role) => {
        const res = await codeOf(
          controller.create(body({ offline: true, offlineQuote: quote }), payload(role)),
        );
        expect(res).toMatchObject({ status: 403, code: "OFFLINE_STAFF_ONLY" });
        expect(ordersService.findActiveOrder).not.toHaveBeenCalled();
        expect(ordersService.create).not.toHaveBeenCalled();
      },
    );

    it("offline:false from a customer is no offline request", async () => {
      await controller.create(body({ offline: false }), payload("CUSTOMER"));
      expect(ordersService.create.mock.calls[0][2]).not.toHaveProperty("offline");
    });
  });

  describe("B7: no money offline; a quote is required", () => {
    it("appliedCreditNotes: 400 OFFLINE_CREDITS_ONLINE_ONLY", async () => {
      const res = await codeOf(
        controller.create(
          body({
            offline: true,
            offlineQuote: quote,
            appliedCreditNotes: [{ creditNoteId: "cn-1", amount: 5 }],
          }),
          payload("OPERATOR"),
        ),
      );
      expect(res).toMatchObject({ status: 400, code: "OFFLINE_CREDITS_ONLINE_ONLY" });
      expect(ordersService.create).not.toHaveBeenCalled();
    });

    it("an empty appliedCreditNotes array still books nothing and is accepted", async () => {
      await controller.create(
        body({ offline: true, offlineQuote: quote, appliedCreditNotes: [] }),
        payload("OPERATOR"),
      );
      expect(ordersService.create).toHaveBeenCalledTimes(1);
    });

    it("inlineReturn (a return credit minted inside the order): 400 OFFLINE_PAYMENT_ONLINE_ONLY", async () => {
      const res = await codeOf(
        controller.create(
          body({
            offline: true,
            offlineQuote: quote,
            inlineReturn: { items: [{ productId: "prod-1", qty: 1 }], returnKey: "rk-1" },
          }),
          payload("OPERATOR"),
        ),
      );
      expect(res).toMatchObject({ status: 400, code: "OFFLINE_PAYMENT_ONLINE_ONLY" });
      expect(ordersService.create).not.toHaveBeenCalled();
    });

    it("no offlineQuote: 400 OFFLINE_QUOTE_REQUIRED (fail closed)", async () => {
      const res = await codeOf(controller.create(body({ offline: true }), payload("OPERATOR")));
      expect(res).toMatchObject({ status: 400, code: "OFFLINE_QUOTE_REQUIRED" });
      expect(ordersService.create).not.toHaveBeenCalled();
    });

    it.each([
      ["a line index past the items", { total: 10, lines: [{ ...quote.lines[0], index: 1 }] }],
      ["a negative index", { total: 10, lines: [{ ...quote.lines[0], index: -1 }] }],
      ["a repeated index", { total: 10, lines: [quote.lines[0], quote.lines[0]] }],
      [
        "more lines than items",
        { total: 10, lines: [quote.lines[0], { ...quote.lines[0], index: 1 }] },
      ],
    ])("an unusable quote (%s): 400 OFFLINE_QUOTE_REQUIRED", async (_n, bad) => {
      const res = await codeOf(
        controller.create(body({ offline: true, offlineQuote: bad }), payload("OPERATOR")),
      );
      expect(res).toMatchObject({ status: 400, code: "OFFLINE_QUOTE_REQUIRED" });
      expect(ordersService.create).not.toHaveBeenCalled();
    });

    it("without offline the same body keeps today's behaviour: the quote fields are ignored", async () => {
      const res = await codeOf(
        controller.create(
          body({ appliedCreditNotes: [{ creditNoteId: "cn-1" }] }),
          payload("OPERATOR"),
        ),
      );
      expect(res).toMatchObject({ status: 409, code: "MERGE_CHOICE_REQUIRED" }); // master observed
    });
  });
});
