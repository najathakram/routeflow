/**
 * Counter-sales launch, tier 1 (Lead ruling 2026-10-26): "Reopen order" (DELIVERED -> CONFIRMED, or back to
 * PARTIALLY_DELIVERED) on a PAID walk-in sale re-opens a sale the till has already closed: the walk-in holds no
 * receivable (SA-932), so the reopened order and its invoice could never be collected. `changeStatus` refuses it with
 * the same WALK_IN_SALE_PAID 409 the edit paths use. A named customer's paid order and an unpaid walk-in pickup keep
 * their reopen.
 */
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

const delivered = (isWalkIn: boolean) => ({
  id: "ord-1",
  tenantId: "t1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "DELIVERED",
  fulfillPath: "PICKUP",
  routeRunId: null,
  routeRunStopId: null,
  subtotal: 10,
  tax: 0,
  total: 10,
  deliveredAt: new Date("2026-10-26T12:00:00Z"),
  orderDate: new Date("2026-10-26T12:00:00Z"),
  customer: { businessName: "Walk-in", isWalkIn },
  lineItems: [],
});

async function reopen(opts: { isWalkIn: boolean; paid: boolean; to?: string }) {
  const h = await buildOrdersService();
  const { customer, ...row } = delivered(opts.isWalkIn); // changeStatus reads the BARE order row: no customer on it
  jest.spyOn(h.service, "findOneOrThrow").mockResolvedValue(row as never);
  h.prisma.order.findUnique.mockResolvedValue({
    ...row,
    customer: { isWalkIn: customer.isWalkIn },
  });
  h.prisma.order.findFirst.mockResolvedValue({ routeRunStopId: null });
  h.prisma.order.update.mockResolvedValue({ ...row, status: opts.to ?? "CONFIRMED" });
  h.prisma.invoicePayment.findFirst.mockResolvedValue(opts.paid ? { id: "pay1" } : null);
  const run = () =>
    h.service.changeStatus(
      "ord-1",
      { status: (opts.to ?? "CONFIRMED") as never, reason: "customer changed their mind" },
      operatorPayload as never,
    );
  return { h, run };
}

describe("reopening a delivered order: the paid walk-in sale stays closed", () => {
  it("DELIVERED -> CONFIRMED on a paid walk-in sale is refused WALK_IN_SALE_PAID (409), nothing written", async () => {
    const { h, run } = await reopen({ isWalkIn: true, paid: true });
    await expect(run()).rejects.toMatchObject({
      status: 409,
      response: { code: "WALK_IN_SALE_PAID" },
    });
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("DELIVERED -> PARTIALLY_DELIVERED (the other reopen) is refused the same way", async () => {
    const { run } = await reopen({ isWalkIn: true, paid: true, to: "PARTIALLY_DELIVERED" });
    await expect(run()).rejects.toMatchObject({ response: { code: "WALK_IN_SALE_PAID" } });
  });

  it("an unpaid walk-in pickup keeps its reopen", async () => {
    const { run } = await reopen({ isWalkIn: true, paid: false });
    await expect(run()).resolves.toBeDefined();
  });

  it("a named customer's paid order keeps its reopen, and no payment is read", async () => {
    const { h, run } = await reopen({ isWalkIn: false, paid: true });
    await expect(run()).resolves.toBeDefined();
    expect(h.prisma.invoicePayment.findFirst).not.toHaveBeenCalled();
  });
});
