import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * W-1188 review SHOULD (reader B, M2): `createSale` picks the date policy from `sale.counterSale`
 * (`saleDateGate`). Forcing it to OFFICE must turn the counter's future-date row red, so the till's
 * "any date ahead" rule is pinned through the service and not only through `resolveOrderDate`.
 */
describe("OrdersService.createSale: the order date policy follows the counter flag", () => {
  // a tenant admin ignores the denied groups, so the gate under test is the policy alone
  const admin = { ...operatorPayload, role: "TENANT_ADMIN" as const };
  const NOW = new Date("2026-11-09T18:00:00.000Z");
  const dto = (orderDate: string) =>
    ({
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 1, unitPrice: 5 }],
      deliveredNow: true,
      orderDate,
    }) as never;

  async function setup() {
    const h = await buildOrdersService();
    const create = jest.spyOn(h.service, "create").mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      status: "PENDING",
    } as never);
    return { h, create };
  }

  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  it("counter sale dated a week ahead: no error, create() gets the day, and delivery is stamped now", async () => {
    const { h, create } = await setup();
    await h.service.createSale(dto("2026-11-16"), admin as never, { counterSale: true });
    expect(create.mock.calls[0][0]).toMatchObject({ orderDate: "2026-11-16" });
    expect(create.mock.calls[0][2]).toMatchObject({ counterSale: true });
    const stamped = (h.prisma.order.update as jest.Mock).mock.calls[0][0].data.deliveredAt as Date;
    expect(stamped.toISOString()).toBe(NOW.toISOString());
  });

  it("the office twin (no counter flag) refuses the same day with 400 ORDER_DATE_OUT_OF_RANGE", async () => {
    const { h, create } = await setup();
    const err = await h.service.createSale(dto("2026-11-16"), admin as never).then(
      () => null,
      (e: any) => e,
    );
    expect(err?.getStatus()).toBe(400);
    expect(err?.getResponse()).toMatchObject({
      code: "ORDER_DATE_OUT_OF_RANGE",
      policy: "OFFICE",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
