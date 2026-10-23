import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * L8 addendum: `PATCH /orders/:id/fulfil-path` re-judges selling restrictions on EVERY change of path, because
 * the path decides WHICH state judges (pickup / counter: the store's; route / ship: the customer's address).
 * The engine's state choice is pinned in `selling-restrictions.store-state.spec.ts`; this pins the CALL: which
 * kind, which lines, which channel, and that a refusal writes nothing.
 */
describe("OrdersService.updateFulfillPath: selling restrictions (L8)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const operator = { ...operatorPayload, tenantId: "t-1" } as never;
  const lines = [{ productId: "prod-1" }, { productId: null }, { productId: "prod-2" }];
  const open = (extra: Record<string, unknown> = {}) =>
    h.prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      tenantId: "t-1",
      customerId: "cust-1",
      status: "CONFIRMED",
      fulfillPath: "ROUTE",
      counterSale: false,
      routeRunId: null,
      routeRunStopId: null,
      routeRunStop: null,
      routeRun: null,
      customer: { addresses: [{ id: "a1" }] },
      lineItems: lines,
      ...extra,
    });
  const switchTo = (fulfillPath: string) =>
    h.service.updateFulfillPath("ord-1", { fulfillPath } as never, operator);
  const refuse = () =>
    h.restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: API_ERROR_CODES.SELLING_RESTRICTED, blockedLines: [] }),
    );
  const nothingWritten = () => {
    expect(h.prisma.order.update).not.toHaveBeenCalled();
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    h = await buildOrdersService();
    // BO-07: an OPERATOR switching to PICKUP is judged on the live user row; this one denies nothing.
    h.prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: [],
      permissionsVersion: 1,
    });
    h.prisma.order.update.mockImplementation((a: any) =>
      Promise.resolve({ id: "ord-1", ...a.data }),
    );
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it("delivery -> pickup judges the order's catalog lines on the PICKUP kind (the store's state)", async () => {
    open();
    await switchTo("PICKUP");
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith({
      tenantId: "t-1",
      customerId: "cust-1",
      lines: [{ productId: "prod-1" }, { productId: "prod-2" }],
      channel: "STAFF",
      fulfilmentKind: "PICKUP",
    });
  });

  it.each(["ROUTE", "SHIP"])(
    "pickup -> %s judges on the DELIVERY kind (the customer's address state)",
    async (target) => {
      open({ fulfillPath: "PICKUP" });
      await switchTo(target);
      expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ fulfilmentKind: "DELIVERY", customerId: "cust-1" }),
      );
    },
  );

  it("a COUNTER sale stays a counter sale whatever path it is switched to: judged COUNTER", async () => {
    open({ counterSale: true, fulfillPath: "PICKUP" });
    await switchTo("SHIP");
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ fulfilmentKind: "COUNTER" }),
    );
  });

  it("a restricted result is the coded 409 and NOTHING is written (the path stays)", async () => {
    open({ fulfillPath: "PICKUP" });
    refuse();
    await expect(switchTo("SHIP")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.SELLING_RESTRICTED },
    });
    nothingWritten();
  });

  it("the refusal also stops a switch to pickup that carries a run link (no release written)", async () => {
    open({ routeRunId: "run-1", routeRunStopId: "stop-1" });
    refuse();
    await expect(switchTo("PICKUP")).rejects.toMatchObject({ status: 409 });
    nothingWritten();
  });

  it("pickup -> delivery for a customer with NO address is a coded 400, nothing written, nothing judged", async () => {
    open({ fulfillPath: "PICKUP", customer: { addresses: [] } });
    await expect(switchTo("SHIP")).rejects.toMatchObject({
      status: 400,
      response: { code: API_ERROR_CODES.ORDER_DELIVERY_ADDRESS_MISSING },
    });
    expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("delivery -> pickup needs no address", async () => {
    open({ customer: { addresses: [] } });
    await expect(switchTo("PICKUP")).resolves.toBeDefined();
  });

  it("the channel is the acting principal's: a buyer-class principal would be judged BUYER_PORTAL", async () => {
    open();
    await h.service.updateFulfillPath(
      "ord-1",
      { fulfillPath: "PICKUP" } as never,
      { ...operatorPayload, tenantId: "t-1", role: "TENANT_ADMIN" } as never,
    );
    expect(h.restrictions.assertLinesSellable.mock.calls[0][0].channel).toBe("STAFF");
  });

  describe("controls", () => {
    it("an order with no catalog lines asks nothing and the switch succeeds", async () => {
      open({ lineItems: [{ productId: null }] });
      await expect(switchTo("PICKUP")).resolves.toBeDefined();
      expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
    });

    it("the same path again changes nothing and judges nothing", async () => {
      open();
      await switchTo("ROUTE");
      expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
    });

    it("a DRAFT is judged at its promotion, not on a path switch", async () => {
      open({ status: "DRAFT" });
      await switchTo("PICKUP");
      expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
    });

    it.each(["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])(
      "a %s order keeps today's 400 and judges nothing",
      async (status) => {
        open({ status });
        await expect(switchTo("PICKUP")).rejects.toMatchObject({ status: 400 });
        expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
      },
    );
  });
});
