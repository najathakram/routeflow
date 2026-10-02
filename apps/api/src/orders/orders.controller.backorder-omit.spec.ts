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
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import { withStockWrite } from "./order-stock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * SA-606p: an EXECUTED staff pin, beyond the static "never imports the helper" pin. The real
 * OrdersService hands the locked write back on the order it returns (a non-enumerable carrier), so
 * these cases return carrier-bearing orders from a mocked service and actually run the staff
 * controller's create and updateOrderItems paths: the serialized result must carry NO
 * `backorderPieces` (absent = unknown; only the BUYER controller reports the figure).
 */
const staff = (role: "OPERATOR" | "TENANT_ADMIN"): JwtPayload => ({
  sub: "user-1",
  username: "u",
  role,
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: null,
  tenantSlug: null,
});
const write = () => ({ backorderByProduct: new Map([["prod-1", 3]]) });
const carrying = (id: string) =>
  withStockWrite(
    {
      id,
      customerId: "cust-1",
      lineItems: [
        {
          id: "l1",
          productId: "prod-1",
          qty: 8,
          status: "PENDING",
          product: { unitsPerBox: null },
        },
      ],
    },
    write(),
  );
const wireHasNoFigure = (res: any) => {
  expect(JSON.stringify(res)).not.toMatch(/backorder/i);
  for (const l of res.lineItems ?? []) expect("backorderPieces" in l).toBe(false);
};

describe("OrdersController (staff) never reports backorderPieces", () => {
  let controller: OrdersController;
  let orders: Record<string, jest.Mock>;

  beforeEach(async () => {
    orders = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      updateOrderItems: jest.fn(),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      findOne: jest.fn(),
      create: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: OrdersService, useValue: orders },
        { provide: ChangeRequestsService, useValue: {} },
      ],
    }).compile();
    controller = module.get(OrdersController);
  });

  it.each([["OPERATOR" as const], ["TENANT_ADMIN" as const]])(
    "%s POST /orders (create) returns the order with no figure",
    async (role) => {
      orders.create.mockResolvedValue(carrying("o-new"));
      const res: any = await controller.create(
        { customerId: "cust-1", items: [{ productId: "prod-1", qty: 8 }] } as any,
        staff(role),
      );
      expect(orders.create).toHaveBeenCalledTimes(1);
      wireHasNoFigure(res);
    },
  );

  it("POST /orders into an open order (merge) returns no figure", async () => {
    orders.findActiveOrder.mockResolvedValue({
      id: "o-open",
      orderNumber: "A1",
      status: "PENDING",
      total: 10,
      createdAt: new Date(),
      lineItems: [{ productId: "prod-1", qty: 2, unitPrice: 5, priceType: "MANUAL", name: null }],
    });
    orders.updateOrderItems.mockResolvedValue(carrying("o-open"));
    orders.findOne.mockResolvedValue(carrying("o-open"));
    const res: any = await controller.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 8 }],
        mergeChoice: "merge",
      } as any,
      staff("OPERATOR"),
    );
    expect(orders.updateOrderItems).toHaveBeenCalled();
    wireHasNoFigure(res);
  });

  it.each([["OPERATOR" as const], ["TENANT_ADMIN" as const]])(
    "%s PATCH /orders/:id/items (updateOrderItems) returns no figure",
    async (role) => {
      orders.updateOrderItems.mockResolvedValue(carrying("o-1"));
      const res: any = await controller.updateOrderItems("o-1", { items: [] } as any, staff(role));
      expect(orders.updateOrderItems).toHaveBeenCalledTimes(1);
      wireHasNoFigure(res);
    },
  );
});
