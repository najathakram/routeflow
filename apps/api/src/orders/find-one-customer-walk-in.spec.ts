jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { OrdersService } from "./orders.service";

/**
 * The staff order detail must carry `customer.isWalkIn` so the client can hide "On account" for a walk-in
 * (a walk-in has no account to put a balance on). The select, not the mapper, decides what is returned.
 */
const operator = {
  sub: "u-op",
  username: "op",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
} as never;

describe("OrdersService.findOne customer select", () => {
  it("asks for isWalkIn on the customer", async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: "o-1",
      status: "PENDING",
      customerId: "c-1",
      routeRun: null,
      lineItems: [],
    });
    const service = Object.assign(Object.create(OrdersService.prototype), {
      prisma: { forTenant: () => ({ order: { findUnique } }) },
    }) as OrdersService;
    await service.findOne("o-1", operator);
    const select = findUnique.mock.calls[0][0].include.customer.select;
    expect(select.isWalkIn).toBe(true);
  });
});
