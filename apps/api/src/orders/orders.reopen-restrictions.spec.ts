import { buildOrdersService } from "./testing/orders-service-harness";
import { ConflictException } from "@nestjs/common";

/**
 * F-05 (#2093, SA-272) — `reopenOrder` moves the ORDER from CANCELLED to PENDING, so EVERY line goes live: a new
 * sale of the whole order. It therefore asks the selling-restrictions choke point about EVERY catalog line
 * (STAFF channel, no delta) BEFORE the transaction writes anything — not only the item-CANCELLED lines, because
 * cancelling a DRAFT never marks its lines CANCELLED and drafts are written without the check (so a banned
 * product on a draft, cancelled, then reopened, would otherwise come back live). The choke point itself is
 * proven in `selling-restrictions.service.spec.ts`.
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
  // a line that was NEVER item-cancelled: a DRAFT's lines stay PENDING when the draft is cancelled
  const draftLine = { id: "li-d", productId: "prod-banned", qty: 3, status: "PENDING" };
  const live = { id: "li-l", productId: "prod-live", qty: 3, status: "PENDING" };

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const reopen = (o: object) => {
    h.prisma.order.findUnique.mockResolvedValue(o);
    h.prisma.invoice.findFirst.mockResolvedValue(null);
    return h.service.reopenOrder("ord-1");
  };
  const banned = () =>
    h.restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] }),
    );

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.orderItem.findMany.mockResolvedValue([]);
  });

  it("asks about EVERY catalog line (cancelled or not; productless dropped), as STAFF, with no delta", async () => {
    await reopen(order([cancelledBanned, cancelledFree, draftLine, live])).catch(() => undefined);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith({
      tenantId: "t-row",
      customerId: "cust-1",
      lines: [
        { productId: "prod-banned" },
        { productId: "prod-banned" },
        { productId: "prod-live" },
      ],
      channel: "STAFF",
    });
  });

  it("a ban on an item-CANCELLED line refuses the reopen with the 409 and writes NOTHING", async () => {
    banned();
    await expect(reopen(order([cancelledBanned]))).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(h.prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("DRAFT with a banned line -> cancel -> reopen: the line is still PENDING (never item-cancelled), and the reopen is a 409 with nothing written", async () => {
    banned();
    await expect(reopen(order([draftLine]))).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ lines: [{ productId: "prod-banned" }] }),
    );
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(h.prisma.order.update).not.toHaveBeenCalled();
  });

  it("an order with no catalog line asks with no lines (the choke point answers ALLOW without a read)", async () => {
    await reopen(order([cancelledFree])).catch(() => undefined);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ lines: [] }),
    );
  });
});
