import { ConflictException } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { ORDER_SOURCE_RECORDED_FROM } from "./line-author-channel";

/**
 * The legacy-source CUTOFF at the DRAFT promotion (changeStatus). An order created before
 * ORDER_SOURCE_RECORDED_FROM carries the column-default source APP whoever created it, so it is UNKNOWN_LEGACY and
 * its creation channel is STAFF; a line a buyer path adds after the cutoff is still judged on BUYER_PORTAL.
 */
describe("changeStatus: DRAFT promotion and the legacy-source cutoff", () => {
  const BEFORE = new Date(ORDER_SOURCE_RECORDED_FROM.getTime() - 86_400_000);
  const AFTER = new Date(ORDER_SOURCE_RECORDED_FROM.getTime() + 86_400_000);
  const draft = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: "t-1",
    orderNumber: "ORD-1",
    status: "DRAFT",
    source: "APP",
    createdAt: BEFORE,
    orderDate: null as Date | null,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme" },
    lineItems: [],
  };
  const operator = { ...operatorPayload, tenantId: "t-1" } as never;
  const line = (productId: string, createdAt: Date) => ({
    productId,
    qty: 2,
    trackedCategoryId: null,
    createdAt,
  });
  const revision = (
    revisionNumber: number,
    createdAt: Date,
    role: string | null,
    ...ids: string[]
  ) => ({
    revisionNumber,
    createdAt,
    editedByRole: role,
    snapshot: { lineItems: ids.map((productId) => ({ productId, qty: 2 })) },
  });

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const promote = () => h.service.changeStatus("ord-1", { status: "PENDING" as never }, operator);
  const arrange = (
    createdAt: Date,
    lines: Array<ReturnType<typeof line>>,
    revisions: unknown[],
  ) => {
    h.prisma.order.findUnique.mockResolvedValue({ ...draft, createdAt });
    h.prisma.orderItem.findMany.mockResolvedValue(lines);
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
  /** A product refused on exactly one channel. */
  const bannedOn = (channel: string, productId: string) =>
    h.restrictions.assertLinesSellable.mockImplementation(
      async (p: { channel: string; lines: Array<{ productId: string }> }) => {
        if (p.channel === channel && p.lines.some((l) => l.productId === productId))
          throw new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] });
      },
    );

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.product.findMany.mockResolvedValue([]);
    h.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.order.findUniqueOrThrow.mockResolvedValue({ ...draft, status: "PENDING" });
  });

  it("(a) a legacy APP draft promoted by staff is judged on STAFF: a portal-only limit does not block", async () => {
    arrange(BEFORE, [line("p-portal-only", BEFORE)], []);
    bannedOn("BUYER_PORTAL", "p-portal-only");

    await expect(promote()).resolves.toMatchObject({ status: "PENDING" });

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF" }),
    );
  });

  it("(a) a legacy APP draft promoted by staff still refuses a staff-level ban", async () => {
    arrange(BEFORE, [line("p-banned", BEFORE)], []);
    bannedOn("STAFF", "p-banned");

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("(b) a post-cutoff customer draft (source APP) is judged on BUYER_PORTAL", async () => {
    arrange(AFTER, [line("p-portal-only", AFTER)], []);
    bannedOn("BUYER_PORTAL", "p-portal-only");

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "BUYER_PORTAL" }),
    );
  });

  it("(c) a legacy draft plus a buyer-added line after the cutoff: the new line is BUYER, the legacy line STAFF", async () => {
    arrange(
      BEFORE,
      [line("p-old", BEFORE), line("p-new", AFTER)],
      [revision(1, AFTER, "CUSTOMER", "p-old", "p-new")],
    );
    bannedOn("BUYER_PORTAL", "p-new");

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "BUYER_PORTAL", lines: [{ productId: "p-new" }] }),
    );
  });

  it("(c) control: the legacy line alone (portal-only ban on it) still promotes on STAFF", async () => {
    arrange(
      BEFORE,
      [line("p-old", BEFORE), line("p-new", AFTER)],
      [revision(1, AFTER, "CUSTOMER", "p-old", "p-new")],
    );
    bannedOn("BUYER_PORTAL", "p-old");

    await expect(promote()).resolves.toMatchObject({ status: "PENDING" });
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF", lines: [{ productId: "p-old" }] }),
    );
  });
});
