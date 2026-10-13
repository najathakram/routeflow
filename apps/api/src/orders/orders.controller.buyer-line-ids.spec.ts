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
import { leakyOrder } from "../common/testing/customer-leak-fixtures";

/**
 * B297 row 352: a CUSTOMER principal can also reach `PATCH /orders/:id/items` (RolesGuard admits it). That
 * route must resolve the entries' `orderItemId` exactly as the buyer route does — otherwise the same edit
 * re-stamps every line from today's category. Staff and drivers keep the three-argument call.
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

async function boot() {
  const ordersService = { updateOrderItems: jest.fn().mockResolvedValue(leakyOrder()) };
  const moduleRef = await Test.createTestingModule({
    controllers: [OrdersController],
    providers: [
      { provide: OrdersService, useValue: ordersService },
      { provide: ChangeRequestsService, useValue: {} },
      { provide: OrderBatchShipService, useValue: {} },
      { provide: PackingSlipService, useValue: {} },
    ],
  }).compile();
  return { controller: moduleRef.get(OrdersController), ordersService };
}

describe("PATCH /orders/:id/items passes buyerLineIds for a CUSTOMER only (row 352)", () => {
  const dto = { items: [{ productId: "p1", qty: 1, orderItemId: "li-1" }] } as never;

  it("CUSTOMER: the line-id resolve is switched on", async () => {
    const { controller, ordersService } = await boot();
    const user = principal("CUSTOMER");
    await controller.updateOrderItems("ord-1", dto, user);
    expect(ordersService.updateOrderItems).toHaveBeenCalledWith("ord-1", dto, user, {
      buyerLineIds: true,
    });
  });

  it.each(["OPERATOR", "DRIVER"] as const)("%s: the plain three-argument call", async (role) => {
    const { controller, ordersService } = await boot();
    const user = principal(role);
    await controller.updateOrderItems("ord-1", dto, user);
    expect(ordersService.updateOrderItems).toHaveBeenCalledWith("ord-1", dto, user);
  });
});
