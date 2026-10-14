import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * Row 506: `PATCH /orders/:id/fulfill-path` refuses a path the account does not offer. The offer comes
 * from the ONE capability derivation (`capabilityForMode`, the same `methods` the web's Fulfillment select
 * reads), so create and the switch can never disagree. A refusal is the coded 400
 * FULFIL_METHOD_NOT_OFFERED with nothing written. PICKUP stays the POS-mode switch (SA-763r): a staff
 * member who may use it is not limited by the portal's list, and everyone else is refused 403 first.
 */
describe("OrdersService.updateFulfillPath: refuses a path the account does not offer", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const mode = (m: string | Error) => {
    (h.service as any).featureConfig = {
      getEffectiveMode: jest.fn(async () => {
        if (m instanceof Error) throw m;
        return m;
      }),
    };
  };
  const toPath = (fulfillPath: string, user: unknown = operatorPayload) =>
    h.service.updateFulfillPath("ord-1", { fulfillPath } as any, user as any);
  const refused = (fulfillPath: string) =>
    expect(toPath(fulfillPath)).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
    });

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      status: "CONFIRMED",
      routeRunId: null,
      routeRunStopId: null,
      routeRunStop: null,
      routeRun: null,
    });
    h.prisma.order.update.mockImplementation((a: any) =>
      Promise.resolve({ id: "ord-1", ...a.data }),
    );
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
  });

  describe("ship-only account", () => {
    beforeEach(() => mode("ship"));
    it("SHIP is accepted", async () => {
      expect((await toPath("SHIP")).fulfillPath).toBe("SHIP");
    });
    it("ROUTE is refused (coded 400), nothing written", async () => {
      await refused("ROUTE");
      expect(h.prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe("pickup-only account", () => {
    beforeEach(() => mode("pickup"));
    it.each(["SHIP", "ROUTE"])("%s is refused (coded 400), nothing written", async (p) => {
      await refused(p);
      expect(h.prisma.order.update).not.toHaveBeenCalled();
      expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
    });
    it("PICKUP is accepted", async () => {
      expect((await toPath("PICKUP")).fulfillPath).toBe("PICKUP");
    });
  });

  describe("delivery-only account", () => {
    beforeEach(() => mode("delivery"));
    it("SHIP is refused, ROUTE is accepted", async () => {
      await refused("SHIP");
      expect((await toPath("ROUTE")).fulfillPath).toBe("ROUTE");
    });
  });

  describe.each(["both", "unset"])("%s account (ROUTE and SHIP offered)", (m) => {
    beforeEach(() => mode(m));
    it.each(["ROUTE", "SHIP"])("%s is accepted", async (p) => {
      expect((await toPath(p)).fulfillPath).toBe(p);
    });
  });

  it("PICKUP is the POS-mode switch: allowed for a POS-capable role on any account (SA-763r), 403 for the rest", async () => {
    mode("ship");
    expect((await toPath("PICKUP")).fulfillPath).toBe("PICKUP");
    await expect(toPath("PICKUP", customerPayload)).rejects.toMatchObject({ status: 403 });
  });

  it("a capability read that throws fails open (a config blip never blocks the switch)", async () => {
    mode(new Error("db down"));
    expect((await toPath("ROUTE")).fulfillPath).toBe("ROUTE");
    expect((await toPath("SHIP")).fulfillPath).toBe("SHIP");
  });

  it("no config service wired: today's behaviour", async () => {
    expect((await toPath("ROUTE")).fulfillPath).toBe("ROUTE");
  });
});
