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
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * The order bodies a CUSTOMER gets back from the staff orders controller's write routes carry
 * customer-facing fields only; staff (and driver) callers get the service's object itself,
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

const orderRow = () => ({
  id: "ord-1",
  customerId: "cust-1",
  status: "PENDING",
  commissionRatePct: 7.5,
  lineItems: [{ id: "li-1", unitPrice: 5, overrideReason: "staff-only", overriddenBy: "u-op" }],
});

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
  it("customer: no commission rate, no line override reason/author", async () => {
    const { controller } = await boot();
    const out = (await call(controller, principal("CUSTOMER"))) as Record<string, unknown> & {
      lineItems: object[];
    };
    expect(out).not.toHaveProperty("commissionRatePct");
    expect(out.lineItems[0]).toEqual({ id: "li-1", unitPrice: 5 });
  });

  it.each(["OPERATOR", "DRIVER"] as const)("%s: the service's object, untouched", async (role) => {
    const { controller, row } = await boot();
    const out = await call(controller, principal(role));
    expect(out).toBe(row);
    expect(out).toEqual(orderRow());
  });
});
