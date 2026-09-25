import { buildOrdersService } from "./testing/orders-service-harness";
import { ConflictException } from "@nestjs/common";

/**
 * F-05 (#2093) — `reopenOrder` REVIVES item-CANCELLED lines to PENDING, i.e. it sells them again, so it
 * asks the selling-restrictions choke point about exactly those lines BEFORE the transaction writes
 * anything. Staff-only path (STAFF channel); no qty delta (a revived line is wholly new sale, so it is
 * always checked). An order with no cancelled line asks about nothing. The choke point itself is proven
 * in `selling-restrictions.service.spec.ts`.
 */
describe("OrdersService.reopenOrder — selling restrictions (F-05)", () => {
  const order = (lineItems: object[]) => ({
    id: "ord-1",
    customerId: "cust-1",
    tenantId: "t-row",
    status: "CANCELLED",
    notes: null,
    lineItems,
  });
  const cancelledBanned = { id: "li-b", productId: "prod-banned", qty: 2, status: "CANCELLED" };
  const cancelledFree = { id: "li-c", productId: null, qty: 1, status: "CANCELLED" };
  const live = { id: "li-l", productId: "prod-live", qty: 3, status: "PENDING" };

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const reopen = (o: object) => {
    h.prisma.order.findUnique.mockResolvedValue(o);
    h.prisma.invoice.findFirst.mockResolvedValue(null);
    return h.service.reopenOrder("ord-1");
  };

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.orderItem.findMany.mockResolvedValue([]);
  });

  it("asks about the REVIVED lines only (cancelled, with a product), as STAFF, with no delta", async () => {
    await reopen(order([cancelledBanned, cancelledFree, live])).catch(() => undefined);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith({
      tenantId: "t-row",
      customerId: "cust-1",
      lines: [{ productId: "prod-banned" }],
      channel: "STAFF",
    });
  });

  it("a ban refuses the reopen with the 409 and writes NOTHING", async () => {
    h.restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] }),
    );
    await expect(reopen(order([cancelledBanned]))).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(h.prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("an order with no cancelled line revives nothing, so asks about no line", async () => {
    await reopen(order([live])).catch(() => undefined);
    // asked with NO lines: the choke point answers ALLOW without a single read
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ lines: [] }),
    );
  });
});
