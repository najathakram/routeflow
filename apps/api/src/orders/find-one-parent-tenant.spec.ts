jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { OrdersService } from "./orders.service";

/**
 * A line product's parent that belongs to another tenant is never shown on the order detail (name or otherwise),
 * and `tenantId` is stripped from the parent that is shown. The buyer order read reaches this same method.
 */
const operator = {
  sub: "u-op",
  username: "op",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
} as never;

const line = (id: string, parent: { name: string; tenantId: string }) => ({
  id,
  product: { id: `p-${id}`, name: "Mint", parentProductId: "fam", parent },
});

describe("OrdersService.findOne product parent", () => {
  it("keeps an own-tenant parent without its tenantId and nulls a foreign one", async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: "o-1",
      tenantId: "t-1",
      status: "PENDING",
      customerId: "c-1",
      routeRun: null,
      lineItems: [
        line("own", { name: "Own family", tenantId: "t-1" }),
        line("foreign", { name: "Foreign family", tenantId: "t-2" }),
      ],
    });
    const service = Object.assign(Object.create(OrdersService.prototype), {
      prisma: { forTenant: () => ({ order: { findUnique } }) },
    }) as OrdersService;
    const result: any = await service.findOne("o-1", operator);
    expect(result.lineItems[0].product.parent).toEqual({ name: "Own family" });
    expect(result.lineItems[1].product.parent).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Foreign family");
  });
});
