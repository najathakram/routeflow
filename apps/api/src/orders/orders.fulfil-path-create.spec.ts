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

  describe("pickup modes (pickup mode API)", () => {
    it("pickup tenant, staff, stored-ROUTE customer, nothing explicit: PICKUP", async () => {
      mode("pickup");
      await create({});
      expect(created()).toBe("PICKUP");
    });

    it("pickup tenant, staff sends the hard-coded ROUTE: no preference, PICKUP; explicit SHIP stays SHIP", async () => {
      mode("pickup");
      await create({ fulfillPath: "ROUTE" });
      expect(created()).toBe("PICKUP");
      await create({ fulfillPath: "SHIP" });
      expect(created()).toBe("SHIP");
      await create({ fulfillPath: "PICKUP" });
      expect(created()).toBe("PICKUP");
    });

    it("pickup_ship tenant, a stored-SHIP customer ships; a stored-ROUTE one picks up", async () => {
      mode("pickup_ship");
      stored = "SHIP";
      await create({});
      expect(created()).toBe("SHIP");
      stored = "ROUTE";
      await create({});
      expect(created()).toBe("PICKUP");
    });

    it("pickup tenant, buyer: PICKUP by default and when asked; SHIP or ROUTE is a coded 400, nothing written", async () => {
      mode("pickup");
      await create({}, customerPayload);
      expect(created()).toBe("PICKUP");
      await create({ fulfillPath: "PICKUP" }, customerPayload);
      expect(created()).toBe("PICKUP");
      h.prisma.order.create.mockClear();
      for (const fulfillPath of ["SHIP", "ROUTE"]) {
        await expect(create({ fulfillPath }, customerPayload)).rejects.toMatchObject({
          status: 400,
          response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
        });
      }
      expect(h.prisma.order.create).not.toHaveBeenCalled();
    });

    it("pickup_ship tenant, buyer: SHIP is honoured, ROUTE is refused", async () => {
      mode("pickup_ship");
      await create({ fulfillPath: "SHIP" }, customerPayload);
      expect(created()).toBe("SHIP");
      await expect(create({ fulfillPath: "ROUTE" }, customerPayload)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
      });
    });

    it.each(["unset", "delivery", "both", "ship"])(
      "%s tenant: a staff order asking for PICKUP is a coded 400 (the DTO accepts it, the resolver refuses), nothing written",
      async (m) => {
        mode(m);
        await expect(create({ fulfillPath: "PICKUP" })).rejects.toMatchObject({
          status: 400,
          response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
        });
        expect(h.prisma.order.create).not.toHaveBeenCalled();
      },
    );

    it("unset tenant, buyer: a requested SHIP is ignored (today: the customer's own default, ROUTE)", async () => {
      mode("unset");
      await create({ fulfillPath: "SHIP" }, customerPayload);
      expect(created()).toBe("ROUTE");
    });
  });

  it("(g) SA-678: an unreadable capability fails open to today's rule and the order is created", async () => {
    mode(new Error("db down"));
    await create({});
    expect(created()).toBe("ROUTE");
  });
});
