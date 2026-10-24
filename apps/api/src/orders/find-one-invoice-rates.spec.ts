jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { OrdersService } from "./orders.service";

/**
 * Row 329a: the order edit panel names a tax rate only when a STORED invoice line rate corroborates it (pricing's
 * `storedTaxRatePercent`), so the order read carries each invoice's line `taxRate` (and nothing else of the lines).
 */
const operator = {
  sub: "u-op",
  username: "op",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
} as never;

describe("OrdersService.findOne invoice select", () => {
  it("asks for each invoice line's taxRate only, beside the existing invoice columns", async () => {
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
    const select = findUnique.mock.calls[0][0].include.invoices.select;
    expect(select.items).toEqual({ select: { taxRate: true } });
    expect(select).toMatchObject({ id: true, invoiceNumber: true, status: true, total: true });
    expect(select.payments.select).toBeDefined();
  });
});
