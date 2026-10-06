// order create runs the merge/stock paths under advisory locks: not under test here.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * Order create resolves its fulfil path through the ONE resolver. Real fixtures: a customer whose stored
 * path is ROUTE (the column default: every customer made before the business switched to shipping) in a
 * ship-only tenant, and the same customer in an unset one.
 */
const PRODUCT = { id: "prod-1", name: "Tomatoes", pricePerUnit: 4.99, unit: "punnet" };

describe("OrdersService.create: fulfil path", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let stored: string;
  const mode = (m: string | Error) => {
    (h.service as any).featureConfig = {
      getEffectiveMode: jest.fn(async () => {
        if (m instanceof Error) throw m;
        return m;
      }),
    };
  };
  const created = () => h.prisma.order.create.mock.calls.at(-1)?.[0]?.data?.fulfillPath;

  beforeEach(async () => {
    h = await buildOrdersService();
    stored = "ROUTE";
    // ONE real-shaped customer for every lookup (own-record, staff validation, tier + path)
    const customer = () =>
      Promise.resolve({
        id: "cust-1",
        businessName: "Acme Foods",
        pricingTier: 1,
        fulfillPath: stored,
        deletedAt: null,
        user: { status: "ACTIVE" },
      });
    h.prisma.customer.findFirst.mockImplementation(customer);
    h.prisma.customer.findUnique.mockImplementation(customer);
    h.prisma.product.findMany.mockResolvedValue([PRODUCT]);
    h.prisma.order.create.mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      status: "PENDING",
      total: 4.99,
      urgent: false,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "Acme Foods" },
      lineItems: [],
    });
    (h.service as any).systemConfig.get.mockResolvedValue("0");
  });

  const create = (dto: Record<string, unknown>, user: unknown = operatorPayload) =>
    h.service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }], ...dto } as any,
      user as any,
    );

  it("ship-only tenant, staff order for a stored-ROUTE customer with nothing explicit: SHIP", async () => {
    mode("ship");
    await create({});
    expect(created()).toBe("SHIP");
  });

  it("ship-only tenant, staff sends the stored ROUTE explicitly (web/mobile always do): treated as omitted, SHIP", async () => {
    mode("ship");
    await create({ fulfillPath: "ROUTE" });
    expect(created()).toBe("SHIP");
  });

  it("ship-only tenant, explicit ROUTE for a stored-SHIP customer: coded 400, nothing written", async () => {
    mode("ship");
    stored = "SHIP";
    await expect(create({ fulfillPath: "ROUTE" })).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
    });
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("ship-only tenant, buyer order (no explicit path) for a stored-ROUTE customer: SHIP", async () => {
    mode("ship");
    await create({}, customerPayload);
    expect(created()).toBe("SHIP");
  });

  it.each(["unset", "delivery", "both"])(
    "%s tenant: byte-identical to today (the stored ROUTE stays ROUTE; explicit wins)",
    async (m) => {
      mode(m);
      await create({});
      expect(created()).toBe("ROUTE");
      await create({ fulfillPath: "SHIP" });
      expect(created()).toBe("SHIP");
    },
  );

  it("(g) SA-678: an unreadable capability fails open to today's rule and the order is created", async () => {
    mode(new Error("db down"));
    await create({});
    expect(created()).toBe("ROUTE");
  });
});
