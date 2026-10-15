import { ConflictException } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * UNKNOWN_LEGACY at the DRAFT promotion (changeStatus), keyed on `Order.sourceRecorded` (no clock). A row with
 * sourceRecorded=false carries the column-default source APP whoever created it, so its creation channel is STAFF;
 * a line a buyer path adds through the new code (a RECORDED revision, `sourceRecorded: true` in its snapshot) is
 * still judged on BUYER_PORTAL. createdAt plays no part: the legacy row below is dated far in the future and the
 * recorded one at the epoch, so a clock cutoff would read both the other way round.
 * SA ruling (#3418): the new code writes each line's `authorChannel` (and copies it into the revision snapshot); a
 * line's timestamps never decide its author (the (c) lines carry swapped timestamps on purpose).
 */
describe("changeStatus: DRAFT promotion and the legacy source (sourceRecorded)", () => {
  const CREATED = new Date("2999-01-01T00:00:00.000Z"); // a legacy row's createdAt (no clock reads it)
  const LATER = new Date(CREATED.getTime() + 60_000);
  const EPOCH = new Date(0);
  const draft = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: "t-1",
    orderNumber: "ORD-1",
    status: "DRAFT",
    source: "APP",
    sourceRecorded: false,
    createdAt: CREATED,
    orderDate: null as Date | null,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme" },
    lineItems: [],
  };
  const operator = { ...operatorPayload, tenantId: "t-1" } as never;
  const line = (productId: string, createdAt: Date, authorChannel: string | null = null) => ({
    productId,
    qty: 2,
    trackedCategoryId: null,
    createdAt,
    authorChannel,
  });
  /** A revision the new code wrote: its snapshot carries `sourceRecorded` and each line's `authorChannel`. */
  const revision = (
    revisionNumber: number,
    role: string | null,
    ...lines: Array<[string, string | null]>
  ) => ({
    revisionNumber,
    editedByRole: role,
    snapshot: {
      sourceRecorded: true,
      lineItems: lines.map(([productId, authorChannel]) => ({ productId, qty: 2, authorChannel })),
    },
  });

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const promote = () => h.service.changeStatus("ord-1", { status: "PENDING" as never }, operator);
  const arrange = (
    order: { sourceRecorded: boolean; createdAt: Date },
    lines: Array<ReturnType<typeof line>>,
    revisions: unknown[],
  ) => {
    h.prisma.order.findUnique.mockResolvedValue({ ...draft, ...order });
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
    arrange({ sourceRecorded: false, createdAt: CREATED }, [line("p-portal-only", CREATED)], []);
    bannedOn("BUYER_PORTAL", "p-portal-only");

    await expect(promote()).resolves.toMatchObject({ status: "PENDING" });

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF" }),
    );
  });

  it("(a) a legacy APP draft promoted by staff still refuses a staff-level ban", async () => {
    arrange({ sourceRecorded: false, createdAt: CREATED }, [line("p-banned", CREATED)], []);
    bannedOn("STAFF", "p-banned");

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    expect(h.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("(b) a recorded customer draft (source APP, sourceRecorded) is judged on BUYER_PORTAL", async () => {
    arrange({ sourceRecorded: true, createdAt: EPOCH }, [line("p-portal-only", EPOCH)], []);
    bannedOn("BUYER_PORTAL", "p-portal-only");

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "BUYER_PORTAL" }),
    );
  });

  it("(c) a legacy draft plus a line a buyer added through the new code: the new line is BUYER, the legacy line STAFF", async () => {
    arrange(
      { sourceRecorded: false, createdAt: CREATED },
      [line("p-old", LATER), line("p-new", CREATED, "BUYER")],
      [revision(1, "CUSTOMER", ["p-old", null], ["p-new", "BUYER"])],
    );
    bannedOn("BUYER_PORTAL", "p-new");

    await expect(promote()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "BUYER_PORTAL", lines: [{ productId: "p-new" }] }),
    );
  });

  it("(c) control: the legacy line alone (portal-only ban on it) still promotes on STAFF", async () => {
    arrange(
      { sourceRecorded: false, createdAt: CREATED },
      [line("p-old", LATER), line("p-new", CREATED, "BUYER")],
      [revision(1, "CUSTOMER", ["p-old", null], ["p-new", "BUYER"])],
    );
    bannedOn("BUYER_PORTAL", "p-old");

    await expect(promote()).resolves.toMatchObject({ status: "PENDING" });
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF", lines: [{ productId: "p-old" }] }),
    );
  });
});
