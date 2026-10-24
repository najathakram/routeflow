import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { counterCreditPaidNow } from "./counter-sale/counter-sale-payment";

/**
 * I-120 (SA-861 rules 5 and 6): `changeStatus(id, dto, user, { silent, creditPaidNow })`.
 *  - `silent: true` skips BOTH customer messages of a transition (the push and the messaging event, every kind);
 *    nothing else changes (same table, guards, invoice settle, stock rules).
 *  - `creditPaidNow` nets the till tender at the B585 delivery gate (the S1 rule `creditProjectedTotal`): a customer
 *    paying at the counter is judged on what stays owed.
 * Red on master: the option does not exist (the messages fire; the gate sees the full total).
 */
describe("OrdersService.changeStatus: the silent option and the netted delivery gate (I-120)", () => {
  const order = (status: string, fulfillPath = "ROUTE") => ({
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-123",
    status,
    fulfillPath,
    routeRunId: null,
    routeRunStopId: null,
    total: 100,
    deliveredAt: null,
    orderDate: new Date("2026-10-04T12:00:00Z"),
    customer: { businessName: "Acme Co" },
  });

  async function run(from: string, to: string, opts?: Record<string, unknown>, path = "ROUTE") {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue(order(from, path));
    h.prisma.order.update.mockResolvedValue({ ...order(to, path), status: to });
    (h.service as any).invoicesService.findOpenOrderDraft.mockResolvedValue(null);
    const gate = jest.spyOn(h.service as any, "creditGate").mockResolvedValue(undefined);
    await (h.service as any).changeStatus(
      "ord-1",
      { status: to },
      operatorPayload,
      ...(opts ? [opts] : []),
    );
    await new Promise((r) => setImmediate(r)); // the fire-and-forget messages
    return { h, gate };
  }

  it.each([
    ["PENDING", "CONFIRMED"],
    ["CONFIRMED", "DELIVERED"],
    ["OUT_FOR_DELIVERY", "DELIVERED"],
  ])("silent %s -> %s sends no push and no messaging event", async (from, to) => {
    const { h } = await run(from, to, { silent: true });
    expect(h.sideEffects.notifications.sendToCustomer).not.toHaveBeenCalled();
    expect(h.sideEffects.messaging.notifyEvent).not.toHaveBeenCalled();
  });

  it("silent on a PICKUP order: no READY_FOR_PICKUP handover message either", async () => {
    const { h } = await run("CONFIRMED", "OUT_FOR_DELIVERY", { silent: true }, "PICKUP");
    expect(h.sideEffects.messaging.notifyEvent).not.toHaveBeenCalled();
    expect(h.sideEffects.notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  it("without the option nothing changes: CONFIRMED -> DELIVERED still pushes and fires DELIVERED (guard)", async () => {
    const { h } = await run("CONFIRMED", "DELIVERED");
    expect(h.sideEffects.notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(h.sideEffects.messaging.notifyEvent).toHaveBeenCalledWith(
      "DELIVERED",
      expect.anything(),
    );
  });

  /**
   * R10 on the REAL B585 gate (SA-872 condition 2): only the DB reads are mocked (the tenant's enforce_delivery switch,
   * the customer's credit limit, the exposure rows); creditGate -> assertCreditAtEnforcementPoint ->
   * assertWithinCreditLimit run for real, with the real counterCreditPaidNow.
   */
  async function realGate(opts?: Record<string, unknown>) {
    const h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue(order("CONFIRMED"));
    h.prisma.order.update.mockResolvedValue({ ...order("DELIVERED"), status: "DELIVERED" });
    (h.service as any).invoicesService.findOpenOrderDraft.mockResolvedValue(null);
    h.prisma.systemConfig.findFirst.mockImplementation(async ({ where }: any) =>
      where?.key === "credit_limit.enforce_delivery" ? { value: "true" } : null,
    );
    h.prisma.customer.findFirst.mockResolvedValue({ creditLimit: 50 }); // the $100 order alone is over it
    const err = await (h.service as any)
      .changeStatus("ord-1", { status: "DELIVERED" }, operatorPayload, ...(opts ? [opts] : []))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    return { h, err };
  }

  it("R10 master shape: no netting, the real gate refuses a $100 delivery over a $50 limit (CREDIT_LIMIT_EXCEEDED)", async () => {
    const { err } = await realGate();
    expect((err as any)?.getResponse?.()).toMatchObject({ code: "CREDIT_LIMIT_EXCEEDED" });
  });

  it("R10 the till tender nets the real gate: $100 cash paid at the counter -> nothing stays owed -> it passes", async () => {
    const tender = { method: "CASH", amount: 100 } as never;
    const today = "2026-10-23";
    const { h, err } = await realGate({
      creditPaidNow: (total: number) => counterCreditPaidNow(tender, total, today),
    });
    expect(err).toBeUndefined();
    expect(h.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DELIVERED" }) }),
    );
  });

  it("R10 a post-dated check pays nothing now (counterCreditPaidNow 0): the real gate still refuses", async () => {
    const tender = { method: "CHECK", reference: "1042", checkDate: "2026-10-30" } as never;
    const { err } = await realGate({
      creditPaidNow: (total: number) => counterCreditPaidNow(tender, total, "2026-10-23"),
    });
    expect((err as any)?.getResponse?.()).toMatchObject({ code: "CREDIT_LIMIT_EXCEEDED" });
  });
});
