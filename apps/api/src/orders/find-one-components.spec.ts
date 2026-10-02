jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { OrdersService } from "./orders.service";

/**
 * #2717 M3: the order detail read hands clients each line's frozen components through the read
 * mapper, so `displayUnitPrice4` reaches them as a number (a Prisma Decimal would serialize as a
 * string) and the tenant/parent keys never leave the server.
 */
const operator = {
  sub: "u-op",
  username: "op",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
} as never;

function serviceReturning(order: object) {
  const findUnique = jest.fn().mockResolvedValue(order);
  const service = Object.assign(Object.create(OrdersService.prototype), {
    prisma: { forTenant: () => ({ order: { findUnique } }) },
  }) as OrdersService;
  return { service, findUnique };
}

describe("OrdersService.findOne components", () => {
  it("returns each line's components as views: displayUnitPrice4 a number, position order", async () => {
    const { service } = serviceReturning({
      id: "o-1",
      status: "PENDING",
      customerId: "c-1",
      routeRun: null,
      lineItems: [
        {
          id: "li-1",
          components: [
            {
              id: "c1",
              tenantId: "t-1",
              orderItemId: "li-1",
              componentProductId: "p1",
              name: "B",
              qty: 12,
              displayUnitPrice4: { toString: () => "0.6250" },
              position: 1,
            },
            {
              id: "c0",
              tenantId: "t-1",
              orderItemId: "li-1",
              componentProductId: "p0",
              name: "A",
              qty: 12,
              displayUnitPrice4: null,
              position: 0,
            },
          ],
        },
        { id: "li-2" },
      ],
    });
    const out = (await service.findOne("o-1", operator)) as unknown as {
      lineItems: Array<{ id: string; components?: Array<Record<string, unknown>> }>;
    };
    const comps = out.lineItems[0].components!;
    expect(comps.map((c) => c.position)).toEqual([0, 1]);
    expect(comps[1].displayUnitPrice4).toBe(0.625);
    expect(typeof comps[1].displayUnitPrice4).toBe("number");
    expect(comps[0].displayUnitPrice4).toBeNull();
    expect(comps[1]).not.toHaveProperty("tenantId");
    expect(comps[1]).not.toHaveProperty("orderItemId");
    expect(out.lineItems[1]).not.toHaveProperty("components"); // a plain line is untouched
  });
});
