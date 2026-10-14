import { ConflictException } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * F1(i): a DRAFT promoted by STAFF is judged line by line at the STRICTER of the promoter's channel and the
 * channel of the line's AUTHOR (order-templates' `leastPrivilegedAuthor`), not on the promoter's channel alone.
 * The author comes from what the order records (`line-author-channel.ts`): its creation `source` and its edit
 * revisions; unknown is the BUYER channel. The derivation itself is pinned in line-author-channel.spec.ts; this
 * file pins the CALL: what `changeStatus` asks the choke point, and that a refusal writes nothing.
 */
describe("OrdersService.changeStatus: DRAFT promotion is judged at the line author's channel too (F1 i)", () => {
  const draft = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: "t-1",
    orderNumber: "ORD-1",
    status: "DRAFT",
    source: "PHONE", // created by office staff
    orderDate: null as Date | null,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme" },
    lineItems: [],
  };
  const operator = { ...operatorPayload, tenantId: "t-1" } as never;
  const line = (productId: string) => ({ productId, qty: 2, trackedCategoryId: null });
  const snap = (...ids: string[]) => ({
    lineItems: ids.map((productId) => ({ productId, qty: 2 })),
  });
  const revision = (revisionNumber: number, editedByRole: string | null, ...ids: string[]) => ({
    revisionNumber,
    editedByRole,
    snapshot: snap(...ids),
  });

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const promote = () => h.service.changeStatus("ord-1", { status: "PENDING" as never }, operator);

  /** The engine as the buyer portal sees it: a product banned for buyers is refused on BUYER_PORTAL only. */
  const bannedForBuyers = (banned: string) =>
    h.restrictions.assertLinesSellable.mockImplementation(
      async (p: { channel: string; lines: Array<{ productId: string }> }) => {
        if (p.channel === "BUYER_PORTAL" && p.lines.some((l) => l.productId === banned))
          throw new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] });
      },
    );
  const arrange = (items: string[], source: string, revisions: unknown[]) => {
    h.prisma.order.findUnique.mockResolvedValue({ ...draft, source });
    h.prisma.orderItem.findMany.mockResolvedValue(items.map(line));
    h.prisma.orderRevision.findMany.mockResolvedValue(revisions);
    h.prisma.orderRevision.aggregate.mockResolvedValue({
      _max: {
        revisionNumber: Math.max(
          0,
          ...(revisions as Array<{ revisionNumber: number }>).map((r) => r.revisionNumber),
        ),
      },
    });
  };

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.product.findMany.mockResolvedValue([]);
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.order.findUniqueOrThrow.mockResolvedValue({ ...draft, status: "PENDING" });
    bannedForBuyers("prod-banned");
  });

  it("a buyer's cart folded into a staff draft: the buyer-authored banned line is refused when STAFF promotes, and nothing is written", async () => {
    arrange(["prod-ok", "prod-banned"], "PHONE", [
      revision(1, "CUSTOMER", "prod-ok", "prod-banned"), // the buyer's fold
    ]);

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "BUYER_PORTAL" }),
    );
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("control: the SAME product on a staff-authored line is still judged on STAFF and promotes", async () => {
    arrange(["prod-ok", "prod-banned"], "PHONE", [
      revision(1, "OPERATOR", "prod-ok", "prod-banned"),
    ]);

    await expect(promote()).resolves.toMatchObject({ status: "PENDING" });

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith({
      tenantId: "t-1",
      customerId: "cust-1",
      lines: [{ productId: "prod-ok" }, { productId: "prod-banned" }],
      channel: "STAFF",
    });
  });

  it("a mixed order: the buyer's line goes to BUYER_PORTAL, the staff line stays on STAFF", async () => {
    arrange(["staff-line", "prod-banned"], "PHONE", [
      revision(1, "OPERATOR", "staff-line"),
      revision(2, "CUSTOMER", "staff-line", "prod-banned"),
    ]);

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith({
      tenantId: "t-1",
      customerId: "cust-1",
      lines: [{ productId: "prod-banned" }],
      channel: "BUYER_PORTAL",
    });
  });

  it("an UNKNOWN author is the buyer channel: an order with no recorded staff source", async () => {
    arrange(["prod-banned"], "APP", []);

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
  });

  it("TOCTOU: a buyer edit committed AFTER the check (a new revision) is refused in the transaction, 409 retry", async () => {
    arrange(["prod-ok"], "PHONE", [revision(1, "OPERATOR", "prod-ok")]);
    // the promotion's own in-tx read sees a newer revision than the one that was judged
    h.prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: 2 } });

    const err = await promote().then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/changed while it was being promoted/);
    expect(h.prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
