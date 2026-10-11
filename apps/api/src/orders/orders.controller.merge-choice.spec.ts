// Moved verbatim out of orders.service.spec.ts (size ratchet, #2563): the controller's merge-choice
// routing is its own concern and never touched the service spec's shared fixtures.
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

import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { OrdersController } from "./orders.controller";
import { OrderBatchShipService } from "./order-batch-ship";
import { PackingSlipService } from "./packing-slip.service";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/** "YYYY-MM-DD" offset from today — negative n yields a future date. */
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const operatorPayload: JwtPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: null,
  tenantSlug: null,
};

describe("OrdersController — merge choice vs orderDate", () => {
  let controller: OrdersController;
  let ordersService: {
    findActiveOrder: jest.Mock;
    updateOrderItems: jest.Mock;
    mergeAllPendingForCustomer: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
  };

  const activeOrder = {
    id: "ord-open",
    orderNumber: "ORD-00009",
    status: "PENDING",
    total: 10,
    createdAt: new Date(),
    // priceType MANUAL: only an operator override survives the fold (F30/R11 refined
    // contract) — derived prices are omitted so updateOrderItems re-derives at the
    // merged qty; orders.scan-hardening.spec.ts pins that branch.
    lineItems: [{ productId: "prod-1", qty: 2, unitPrice: 5, priceType: "MANUAL", name: null }],
  };

  beforeEach(async () => {
    ordersService = {
      findActiveOrder: jest.fn().mockResolvedValue(activeOrder),
      updateOrderItems: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(activeOrder),
      create: jest.fn().mockResolvedValue({ id: "ord-new", customerId: "cust-1" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: OrdersService, useValue: ordersService },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: OrderBatchShipService, useValue: {} },
        { provide: PackingSlipService, useValue: {} },
      ],
    }).compile();

    controller = module.get<OrdersController>(OrdersController);
  });

  it("rejects merge + orderDate before any items are folded in", async () => {
    await expect(
      controller.create(
        {
          customerId: "cust-1",
          items: [{ productId: "prod-1", qty: 1 }],
          mergeChoice: "merge",
          orderDate: isoDaysAgo(4),
        } as any,
        operatorPayload,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    expect(ordersService.mergeAllPendingForCustomer).not.toHaveBeenCalled();
    expect(ordersService.create).not.toHaveBeenCalled();
  });

  it("still merges an undated order into the open one", async () => {
    await controller.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1 }],
        mergeChoice: "merge",
      } as any,
      operatorPayload,
    );

    // F30/R11 (B199): the fold carries the EXISTING line's unitPrice through —
    // a merge is never where an operator's price override quietly disappears.
    // B465 fix round 4: the create-merge call site now always passes a 4th
    // opts argument naming isCreateMerge — the ONLY place this ever gets set.
    expect(ordersService.updateOrderItems).toHaveBeenCalledWith(
      "ord-open",
      expect.objectContaining({ items: [{ productId: "prod-1", qty: 3, unitPrice: 5 }] }),
      operatorPayload,
      expect.objectContaining({ isCreateMerge: true }),
    );
  });

  it("a dated order chosen as separate goes through create()", async () => {
    const orderDate = isoDaysAgo(4);

    await controller.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1 }],
        mergeChoice: "separate",
        orderDate,
      } as any,
      operatorPayload,
    );

    expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    expect(ordersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ orderDate }),
      operatorPayload,
      { skipAutoMerge: true },
    );
  });

  // Wiring pins (one predicate, merge-candidates.ts): every merge-target search passes `mergeAs`, so the
  // incoming order's fulfil path decides which open order it may fold into.
  it("the pre-merge candidate search AND its in-lock re-read both pass mergeAs (the request's own path)", async () => {
    await controller.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1 }],
        mergeChoice: "merge",
        fulfillPath: "SHIP",
      } as any,
      operatorPayload,
    );
    const calls = ordersService.findActiveOrder.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, opts] of calls)
      expect(opts).toEqual({
        forMerge: true,
        mergeAs: { explicit: "SHIP", audience: "staff", role: "OPERATOR" },
      });
  });

  it("M2: a driver's post-create sweep folds only the NEW order's path (focusOrderId)", async () => {
    await controller.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] } as any,
      { ...operatorPayload, sub: "user-drv", role: "DRIVER" } as JwtPayload,
    );
    expect(ordersService.mergeAllPendingForCustomer).toHaveBeenCalledWith(
      "cust-1",
      { buyerInitiated: false, focusOrderId: "ord-new" },
      expect.anything(),
    );
  });

  it("GET /orders/active takes the order's path and searches as create would (omitted = the customer's own)", async () => {
    await controller.getActiveOrderForCustomer("cust-1", "SHIP", operatorPayload);
    expect(ordersService.findActiveOrder).toHaveBeenLastCalledWith("cust-1", {
      forMerge: true,
      mergeAs: { explicit: "SHIP", audience: "staff", role: "OPERATOR" },
    });
    await controller.getActiveOrderForCustomer("cust-1", undefined, operatorPayload);
    expect(ordersService.findActiveOrder).toHaveBeenLastCalledWith("cust-1", {
      forMerge: true,
      mergeAs: { explicit: undefined, audience: "staff", role: "OPERATOR" },
    });
    await controller.getActiveOrderForCustomer("cust-1", "garbage", operatorPayload);
    expect(ordersService.findActiveOrder).toHaveBeenLastCalledWith("cust-1", {
      forMerge: true,
      mergeAs: { explicit: undefined, audience: "staff", role: "OPERATOR" },
    });
  });
  it("POS mode: the pre-resolve and the in-lock re-read carry an explicit PICKUP with the caller's role", async () => {
    for (const role of ["OPERATOR", "TENANT_ADMIN"] as const) {
      ordersService.findActiveOrder.mockClear();
      await controller.create(
        {
          customerId: "cust-1",
          items: [{ productId: "prod-1", qty: 1 }],
          mergeChoice: "merge",
          fulfillPath: "PICKUP",
        } as any,
        { ...operatorPayload, role } as JwtPayload,
      );
      const calls = ordersService.findActiveOrder.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const [, opts] of calls)
        expect(opts).toEqual({
          forMerge: true,
          mergeAs: { explicit: "PICKUP", audience: "staff", role },
        });
    }
  });

  it("POS mode: GET /orders/active accepts PICKUP for staff, so the preview and the create pick one target", async () => {
    await controller.getActiveOrderForCustomer("cust-1", "PICKUP", operatorPayload);
    expect(ordersService.findActiveOrder).toHaveBeenLastCalledWith("cust-1", {
      forMerge: true,
      mergeAs: { explicit: "PICKUP", audience: "staff", role: "OPERATOR" },
    });
  });
});
