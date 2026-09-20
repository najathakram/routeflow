import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { ConflictException } from "@nestjs/common";

/**
 * Lane R step 2a-6 — `changeStatus` DRAFT → live is the "draft escape" of the selling-restrictions
 * check: drafts are created and edited without it, so the promotion (the moment the order becomes a
 * real sale) asks the choke point BEFORE the status write and the stock reservation. The choke point
 * itself is proven in `selling-restrictions.service.spec.ts`; this pins the CALL.
 */
describe("OrdersService.changeStatus — DRAFT promotion and selling restrictions (lane R 2a-6)", () => {
  const draft = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: "t-1",
    orderNumber: "ORD-1",
    status: "DRAFT",
    orderDate: null as Date | null,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme" },
    lineItems: [],
  };
  const operator = { ...operatorPayload, tenantId: "t-1" } as never;

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue({ ...draft });
    h.prisma.orderItem.findMany.mockResolvedValue([
      { productId: "prod-1", trackedCategoryId: null },
      { productId: null, trackedCategoryId: null }, // unlisted line: no product to restrict
    ]);
    h.prisma.product.findMany.mockResolvedValue([{ id: "prod-1", trackedCategoryId: null }]);
  });

  it("asks the choke point ONCE, with the order's own tenant / customer, its LISTED products only, and the STAFF channel — before any status write", async () => {
    await h.service
      .changeStatus("ord-1", { status: "PENDING" as never }, operator)
      .catch(() => undefined);

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith({
      tenantId: "t-1",
      customerId: "cust-1",
      lines: [{ productId: "prod-1" }],
      channel: "STAFF", // no `at`: judged at entry time, like the license guard (owner ruling pending)
    });
  });

  it("a refusal (409 SELLING_RESTRICTED) is thrown BEFORE the transition commits: no transaction, no status write", async () => {
    h.restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] }),
    );

    await expect(
      h.service.changeStatus("ord-1", { status: "PENDING" as never }, operator),
    ).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(h.prisma.order.update).not.toHaveBeenCalled();
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("the row's own tenant is authoritative, and a backdated draft is still judged NOW (a staff-settable date must not move a compliance check)", async () => {
    const orderDate = new Date("2026-06-01T00:00:00Z");
    h.prisma.order.findUnique.mockResolvedValue({ ...draft, tenantId: "t-row", orderDate });

    await h.service
      .changeStatus("ord-1", { status: "PENDING" as never }, operator)
      .catch(() => undefined);

    const arg = h.restrictions.assertLinesSellable.mock.calls[0][0];
    expect(arg.tenantId).toBe("t-row");
    expect(arg.at).toBeUndefined();
  });

  it("cancelling a DRAFT is not a sale: never checked; a non-draft transition never reaches the check", async () => {
    await h.service
      .changeStatus("ord-1", { status: "CANCELLED" as never }, operator)
      .catch(() => undefined);
    h.prisma.order.findUnique.mockResolvedValue({ ...draft, status: "PENDING" });
    await h.service
      .changeStatus("ord-1", { status: "CONFIRMED" as never }, operator)
      .catch(() => undefined);

    expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
  });
});
