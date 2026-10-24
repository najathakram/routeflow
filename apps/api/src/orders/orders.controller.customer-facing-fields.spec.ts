jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { Test } from "@nestjs/testing";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import { OrderBatchShipService } from "./order-batch-ship";
import { PackingSlipService } from "./packing-slip.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { expectNoStaffLeaks, leakyOrder } from "../common/testing/customer-leak-fixtures";

/**
 * The order bodies a CUSTOMER gets back from the staff orders controller's write routes carry the
 * customer-facing ALLOWLIST only (no staff-internal key at any depth, present or future); staff (and driver) callers get the service's object itself,
 * untouched. Placeholders only.
 */
const principal = (role: JwtPayload["role"]): JwtPayload => ({
  sub: `user-${role.toLowerCase()}`,
  username: "u",
  role,
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: null,
  tenantSlug: null,
});

const orderRow = leakyOrder;

async function boot() {
  const row = orderRow();
  const ordersService = {
    create: jest.fn().mockResolvedValue(row),
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    changeStatus: jest.fn().mockResolvedValue(row),
    updateOrderItems: jest.fn().mockResolvedValue(row),
    toggleUrgent: jest.fn().mockResolvedValue(row),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [OrdersController],
    providers: [
      { provide: OrdersService, useValue: ordersService },
      { provide: ChangeRequestsService, useValue: {} },
      { provide: OrderBatchShipService, useValue: {} },
      { provide: PackingSlipService, useValue: {} },
    ],
  }).compile();
  return { controller: moduleRef.get(OrdersController), row };
}

type Call = (c: OrdersController, user: JwtPayload) => Promise<unknown>;
const ROUTES: Array<[string, Call]> = [
  ["POST /orders", (c, u) => c.create({ items: [] } as never, u)],
  [
    "PATCH /orders/:id/status",
    (c, u) => c.changeStatus("ord-1", { status: "CANCELLED" } as never, u),
  ],
  ["PATCH /orders/:id/items", (c, u) => c.updateOrderItems("ord-1", { items: [] } as never, u)],
  ["PATCH /orders/:id/urgent", (c, u) => c.toggleUrgent("ord-1", { urgent: true }, u)],
];

describe.each(ROUTES)("%s — customer-facing fields only", (_name, call) => {
  it("customer: only allowlisted fields — no staff-internal key at any depth", async () => {
    const { controller } = await boot();
    const out = (await call(controller, principal("CUSTOMER"))) as Record<string, unknown> & {
      lineItems: object[];
    };
    expectNoStaffLeaks(out);
    expect(out).toMatchObject({ id: "ord-1", status: "PENDING" });
    expect(out.lineItems[0]).toMatchObject({ id: "li-1", unitPrice: 5 });
  });

  it.each(["OPERATOR", "DRIVER"] as const)("%s: the service's object, untouched", async (role) => {
    const { controller, row } = await boot();
    const out = await call(controller, principal(role));
    expect(out).toBe(row);
    expect(out).toEqual(orderRow());
  });
});
