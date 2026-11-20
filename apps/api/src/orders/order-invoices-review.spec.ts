/**
 * B1116: the staff order detail says whether the order's invoices "need review" — the SAME derived
 * predicate (#3216's `invoicesNeedReview`) that makes Mark Delivered / Generate Invoice answer 409
 * ORDER_INVOICES_NEED_REVIEW, so the office sees the problem before it hits the 409.
 *
 * Pinned here: the flag comes from that predicate, plus ONE audit-row case (a stop left a delivered
 * line off every invoice, SA-E217: the row's `meta.kind`, and the line still on no invoice); it is staff-only
 * and the predicate (and every other query behind the field) NEVER runs for a buyer, a customer or
 * a driver; the optional "flagged at a stop" detail is read tenant-scoped from the latest
 * ORDER_INVOICES_NEED_REVIEW audit row and never changes the flag.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../invoices/invoice-partition", () => ({
  ...jest.requireActual("../invoices/invoice-partition"),
  invoicesNeedReview: jest.fn(),
}));

import {
  invoicesNeedReview,
  ORDER_INVOICES_NEED_REVIEW_MESSAGE,
} from "../invoices/invoice-partition";
import { makePseudoUser } from "../buyer/buyer.controller";
import { OrdersService } from "./orders.service";
import { ORDER_LINE_LEFT_OFF_MESSAGE } from "./order-invoices-review";

const predicate = invoicesNeedReview as jest.Mock;

const user = (role: string, extra: Record<string, unknown> = {}) =>
  ({
    sub: "u-1",
    username: "someone",
    role,
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: "t-A",
    tenantSlug: "acme",
    ...extra,
  }) as never;

interface AuditRow {
  tenantId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  userId: string | null;
  createdAt: Date;
  meta?: Record<string, unknown> | null;
}
interface UserRow {
  id: string;
  tenantId: string | null;
  username: string;
  driver?: { contactName: string | null } | null;
}

function harness(
  opts: {
    audit?: AuditRow[];
    users?: UserRow[];
    customerId?: string;
    /** The order's live lines as the left-off read sees them (SA-E217). */
    lines?: Array<{ id: string; deliveredQty: number; status?: string }>;
    /** Invoice lines pointing at an order line, with their invoice's status. */
    invoiceItems?: Array<{ orderItemId: string; invoiceStatus: string }>;
  } = {},
) {
  const order = {
    id: "o-1",
    tenantId: "t-A",
    status: "PENDING",
    customerId: "c-1",
    // A DRIVER may read only an order on a run they drive (the fake driver below is drv-x).
    routeRun: { status: "ACTIVE", startedAt: null, driverId: "drv-x" },
    lineItems: [],
  };
  // Honest fakes: a `where` the service forgets to send (tenant, action, entity) returns the
  // wrong row here exactly as it would in production.
  const auditFindFirst = jest.fn(async (args: any) => {
    const w = args.where ?? {};
    const hit = (opts.audit ?? [])
      .filter(
        (r) =>
          (w.tenantId === undefined || r.tenantId === w.tenantId) &&
          (w.action === undefined || r.action === w.action) &&
          (w.entityId === undefined || r.entityId === w.entityId) &&
          (w.meta === undefined || r.meta?.[w.meta.path[0]] === w.meta.equals) &&
          (w.entityType === undefined ||
            (w.entityType.in
              ? w.entityType.in.includes(r.entityType)
              : r.entityType === w.entityType)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return hit[0] ?? null;
  });
  const userFindFirst = jest.fn(async (args: any) => {
    const w = args.where ?? {};
    return (
      (opts.users ?? []).find(
        (u) => u.id === w.id && (w.tenantId === undefined || u.tenantId === w.tenantId),
      ) ?? null
    );
  });
  // Honest fakes again: each honours the `where` it is sent, so a dropped condition changes the answer.
  const orderItemFindMany = jest.fn(async (args: any) =>
    (opts.lines ?? [])
      .filter(
        (l) =>
          (args.where.status?.not === undefined ||
            (l.status ?? "DELIVERED") !== args.where.status.not) &&
          (args.where.deliveredQty?.gt === undefined ||
            l.deliveredQty > args.where.deliveredQty.gt),
      )
      .map((l) => ({ id: l.id })),
  );
  const invoiceItemFindMany = jest.fn(async (args: any) =>
    (opts.invoiceItems ?? [])
      .filter(
        (i) =>
          args.where.orderItemId.in.includes(i.orderItemId) &&
          (args.where.invoice?.status?.not === undefined ||
            i.invoiceStatus !== args.where.invoice.status.not),
      )
      .map((i) => ({ orderItemId: i.orderItemId })),
  );
  const client = {
    orderItem: { findMany: orderItemFindMany },
    invoiceItem: { findMany: invoiceItemFindMany },
    invoice: { findMany: async () => [] }, // B1372 K2: no sent invoice an edit would revert
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    customer: {
      findFirst: jest.fn().mockResolvedValue({ id: opts.customerId ?? "c-1" }),
    },
    driver: { findFirst: jest.fn().mockResolvedValue({ id: "drv-x" }) },
    auditLog: { findFirst: auditFindFirst },
    user: { findFirst: userFindFirst },
  };
  const service = Object.assign(Object.create(OrdersService.prototype), {
    prisma: { forTenant: () => client },
  }) as OrdersService;
  return { service, client, auditFindFirst, userFindFirst, orderItemFindMany, invoiceItemFindMany };
}

type Detail = { invoicesNeedReview?: Record<string, any> };

beforeEach(() => predicate.mockReset());

describe("OrdersService.findOne — invoicesNeedReview (B1116)", () => {
  it("flags an operator's read when the predicate says the invoices need review", async () => {
    predicate.mockResolvedValue(true);
    const { service, client } = harness();
    const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
    expect(out.invoicesNeedReview).toEqual({
      flagged: true,
      reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
    });
    // The predicate gets the tenant client and THIS order — nothing else decides the flag.
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate.mock.calls[0][0]).toBe(client);
    expect(predicate.mock.calls[0][1]).toBe("o-1");
  });

  it("flags a tenant admin's read too", async () => {
    predicate.mockResolvedValue(true);
    const { service } = harness();
    const out = (await service.findOne("o-1", user("TENANT_ADMIN"))) as unknown as Detail;
    expect(out.invoicesNeedReview?.flagged).toBe(true);
  });

  it("carries flagged:false when the invoices are in step: a leftover row of another kind never turns the badge on", async () => {
    predicate.mockResolvedValue(false);
    const { service, auditFindFirst, userFindFirst, orderItemFindMany } = harness({
      audit: [
        {
          tenantId: "t-A",
          action: "ORDER_INVOICES_NEED_REVIEW",
          entityType: "order",
          entityId: "o-1",
          userId: "drv-1",
          createdAt: new Date("2026-10-05T10:00:00Z"),
        },
      ],
    });
    const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
    // A leftover audit row from an earlier episode never turns the badge on: the only audit read is
    // the left-off one, asked for by kind, and it finds nothing here, so no line is read either.
    // (W-1187: the order read also asks the audit trail who last rearranged the lines; that read is not this signal's.)
    expect(out.invoicesNeedReview).toEqual({ flagged: false });
    const reviewReads = auditFindFirst.mock.calls.filter(
      ([args]) => args.where.action !== "order.lines.reordered",
    );
    expect(reviewReads).toHaveLength(1);
    expect(reviewReads[0][0].where.meta).toEqual({
      path: ["kind"],
      equals: "line-left-off",
    });
    expect(orderItemFindMany).not.toHaveBeenCalled();
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  describe("a delivered line a stop left off every invoice (SA-1098 A-3, SA-E217)", () => {
    const leftOff = (over: Partial<AuditRow> = {}): AuditRow => ({
      tenantId: "t-A",
      action: "ORDER_INVOICES_NEED_REVIEW",
      entityType: "order",
      entityId: "o-1",
      userId: null,
      createdAt: new Date("2026-11-03T10:00:00Z"),
      meta: { context: "stop-completion", kind: "line-left-off", note: "x" },
      ...over,
    });
    const read = async (h: ReturnType<typeof harness>, who = user("OPERATOR")) =>
      ((await h.service.findOne("o-1", who)) as unknown as Detail).invoicesNeedReview;

    beforeEach(() => predicate.mockResolvedValue(false));

    it("flags it, with the reason, while the line is on no invoice (and shows no stop line)", async () => {
      const h = harness({ audit: [leftOff()], lines: [{ id: "li-1", deliveredQty: 2 }] });
      expect(await read(h)).toEqual({ flagged: true, reason: ORDER_LINE_LEFT_OFF_MESSAGE });
      expect(h.auditFindFirst.mock.calls[0][0].where).toMatchObject({
        tenantId: "t-A",
        action: "ORDER_INVOICES_NEED_REVIEW",
        entityType: "order",
        entityId: "o-1",
      });
      expect(h.userFindFirst).not.toHaveBeenCalled();
    });

    it("clears by itself once a non-void invoice carries the line", async () => {
      const h = harness({
        audit: [leftOff()],
        lines: [{ id: "li-1", deliveredQty: 2 }],
        invoiceItems: [{ orderItemId: "li-1", invoiceStatus: "DRAFT" }],
      });
      expect(await read(h)).toEqual({ flagged: false });
    });

    it("a VOID invoice does not count as carrying it", async () => {
      const h = harness({
        audit: [leftOff()],
        lines: [{ id: "li-1", deliveredQty: 2 }],
        invoiceItems: [{ orderItemId: "li-1", invoiceStatus: "VOID" }],
      });
      expect(await read(h)).toEqual({ flagged: true, reason: ORDER_LINE_LEFT_OFF_MESSAGE });
    });

    it("needs a line with a delivered quantity: nothing delivered, nothing flagged", async () => {
      const h = harness({ audit: [leftOff()], lines: [{ id: "li-1", deliveredQty: 0 }] });
      expect(await read(h)).toEqual({ flagged: false });
    });

    it("needs the left-off marker: a stop-completion row without it flags nothing and reads no line", async () => {
      const h = harness({
        audit: [
          leftOff({
            meta: { context: "stop-completion", note: "a delivered line is on no invoice" },
          }),
        ],
        lines: [{ id: "li-1", deliveredQty: 2 }],
      });
      expect(await read(h)).toEqual({ flagged: false });
      expect(h.orderItemFindMany).not.toHaveBeenCalled();
    });

    it("never reads another tenant's row", async () => {
      const h = harness({
        audit: [leftOff({ tenantId: "t-B" })],
        lines: [{ id: "li-1", deliveredQty: 2 }],
      });
      expect(await read(h)).toEqual({ flagged: false });
    });

    it("the predicate's own flag wins and keeps its own reason", async () => {
      predicate.mockResolvedValue(true);
      const h = harness({ audit: [leftOff()], lines: [{ id: "li-1", deliveredQty: 2 }] });
      expect(await read(h)).toEqual({ flagged: true, reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE });
    });

    it("a buyer principal gets no field and no query", async () => {
      const h = harness({ audit: [leftOff()], lines: [{ id: "li-1", deliveredQty: 2 }] });
      const buyer = user("OPERATOR", { type: "BUYER" });
      expect(await read(h, buyer)).toBeUndefined();
      expect(h.auditFindFirst).not.toHaveBeenCalled();
      expect(h.orderItemFindMany).not.toHaveBeenCalled();
    });
  });

  it("is flagged by the predicate alone — no audit row needed", async () => {
    predicate.mockResolvedValue(true);
    const { service } = harness({ audit: [] });
    const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
    expect(out.invoicesNeedReview).toEqual({
      flagged: true,
      reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
    });
    expect(out.invoicesNeedReview).not.toHaveProperty("flaggedAtStop");
  });

  describe("flaggedAtStop (detail only, from the latest audit row)", () => {
    const row = (over: Partial<AuditRow>): AuditRow => ({
      tenantId: "t-A",
      action: "ORDER_INVOICES_NEED_REVIEW",
      entityType: "order",
      entityId: "o-1",
      userId: "drv-1",
      createdAt: new Date("2026-10-05T10:00:00Z"),
      meta: { context: "stop-completion" },
      ...over,
    });

    it("names the driver and when, from the NEWEST row", async () => {
      predicate.mockResolvedValue(true);
      const { service } = harness({
        audit: [
          row({ userId: "drv-old", createdAt: new Date("2026-10-04T09:00:00Z") }),
          row({ userId: "drv-1", createdAt: new Date("2026-10-05T10:00:00Z") }),
        ],
        users: [
          {
            id: "drv-old",
            tenantId: "t-A",
            username: "old",
            driver: { contactName: "Old Driver" },
          },
          { id: "drv-1", tenantId: "t-A", username: "d1", driver: { contactName: "Dana Driver" } },
        ],
      });
      const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
      expect(out.invoicesNeedReview?.flagged).toBe(true);
      expect(out.invoicesNeedReview?.flaggedAtStop).toEqual({
        by: "Dana Driver",
        at: "2026-10-05T10:00:00.000Z",
      });
    });

    it("falls back to the username when the driver has no contact name", async () => {
      predicate.mockResolvedValue(true);
      const { service } = harness({
        audit: [row({})],
        users: [{ id: "drv-1", tenantId: "t-A", username: "d1", driver: { contactName: null } }],
      });
      const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
      expect(out.invoicesNeedReview?.flaggedAtStop?.by).toBe("d1");
    });

    it.each([
      ["another context", { context: "office-recovery" }],
      ["the underscore spelling", { context: "stop_completion" }],
      ["no context key", { note: "x" }],
      ["no meta at all", null],
    ])("shows no stop line for a row with %s (the flag is unchanged)", async (_name, meta) => {
      predicate.mockResolvedValue(true);
      const { service, userFindFirst } = harness({
        audit: [row({ meta })],
        users: [
          { id: "drv-1", tenantId: "t-A", username: "d1", driver: { contactName: "Dana Driver" } },
        ],
      });
      const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
      expect(out.invoicesNeedReview).toEqual({
        flagged: true,
        reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
      });
      expect(userFindFirst).not.toHaveBeenCalled(); // never even resolves a name for it
    });

    it("judges the NEWEST row's context, not an older stop row beneath a newer non-stop row", async () => {
      predicate.mockResolvedValue(true);
      const { service } = harness({
        audit: [
          row({ userId: "drv-1", createdAt: new Date("2026-10-04T09:00:00Z") }),
          row({
            userId: "drv-1",
            createdAt: new Date("2026-10-05T09:00:00Z"),
            meta: { context: "office-recovery" },
          }),
        ],
        users: [
          { id: "drv-1", tenantId: "t-A", username: "d1", driver: { contactName: "Dana Driver" } },
        ],
      });
      const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
      expect(out.invoicesNeedReview).not.toHaveProperty("flaggedAtStop");
    });

    it("omits flaggedAtStop for a row with no user, and for an unresolvable user", async () => {
      predicate.mockResolvedValue(true);
      const noUser = harness({ audit: [row({ userId: null })] });
      const a = (await noUser.service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
      expect(a.invoicesNeedReview).toEqual({
        flagged: true,
        reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
      });
      const gone = harness({ audit: [row({})], users: [] });
      const b = (await gone.service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
      expect(b.invoicesNeedReview?.flagged).toBe(true);
      expect(b.invoicesNeedReview).not.toHaveProperty("flaggedAtStop");
    });

    it("never reads another tenant's audit row or user (tenant isolation)", async () => {
      predicate.mockResolvedValue(true);
      // Same entity id, NEWER, in another tenant — and that tenant's user shares the id.
      const { service, auditFindFirst, userFindFirst } = harness({
        audit: [
          row({ tenantId: "t-B", userId: "drv-B", createdAt: new Date("2026-10-06T10:00:00Z") }),
        ],
        users: [
          {
            id: "drv-B",
            tenantId: "t-B",
            username: "other",
            driver: { contactName: "Other Tenant" },
          },
        ],
      });
      const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
      expect(out.invoicesNeedReview).toEqual({
        flagged: true,
        reason: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
      });
      // The tenant rides IN the query (from the order row), not only the ambient client.
      expect(auditFindFirst.mock.calls[0][0].where.tenantId).toBe("t-A");
      expect(auditFindFirst.mock.calls[0][0].where.entityId).toBe("o-1");
      expect(auditFindFirst.mock.calls[0][0].where.action).toBe("ORDER_INVOICES_NEED_REVIEW");
      expect(userFindFirst).not.toHaveBeenCalled();
    });

    it("scopes the user lookup to the tenant too", async () => {
      predicate.mockResolvedValue(true);
      const { service, userFindFirst } = harness({
        audit: [row({ userId: "drv-B" })],
        users: [
          {
            id: "drv-B",
            tenantId: "t-B",
            username: "other",
            driver: { contactName: "Other Tenant" },
          },
        ],
      });
      const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
      expect(userFindFirst.mock.calls[0][0].where).toMatchObject({ id: "drv-B", tenantId: "t-A" });
      expect(out.invoicesNeedReview).not.toHaveProperty("flaggedAtStop");
    });
  });

  describe("staff only — nothing runs and nothing is returned for anyone else", () => {
    const callers: Array<[string, () => unknown]> = [
      [
        "a buyer-portal principal (makePseudoUser)",
        () => makePseudoUser({ userId: "u-b", tenantId: "t-A", tenantSlug: "acme" }),
      ],
      [
        "a buyer pseudo-user built with role OPERATOR (the findAll/invoices override)",
        () =>
          makePseudoUser({
            userId: "u-b",
            tenantId: "t-A",
            tenantSlug: "acme",
            role: "OPERATOR" as never,
          }),
      ],
      ["a CUSTOMER", () => user("CUSTOMER")],
      ["a DRIVER", () => user("DRIVER")],
    ];

    it.each(callers)("%s", async (_name, who) => {
      predicate.mockResolvedValue(true);
      const { service, auditFindFirst, userFindFirst } = harness({
        audit: [
          {
            tenantId: "t-A",
            action: "ORDER_INVOICES_NEED_REVIEW",
            entityType: "order",
            entityId: "o-1",
            userId: "drv-1",
            createdAt: new Date(),
          },
        ],
      });
      const out = (await service.findOne("o-1", who() as never)) as unknown as Detail;
      expect(predicate).not.toHaveBeenCalled();
      expect(auditFindFirst).not.toHaveBeenCalled();
      expect(userFindFirst).not.toHaveBeenCalled();
      expect(out).not.toHaveProperty("invoicesNeedReview");
      expect(JSON.stringify(out)).not.toContain("invoicesNeedReview");
    });
  });

  it("a failing check never fails the order read — the field is simply absent", async () => {
    predicate.mockRejectedValue(new Error("db down"));
    const { service } = harness();
    const out = (await service.findOne("o-1", user("OPERATOR"))) as unknown as Detail;
    expect(out).not.toHaveProperty("invoicesNeedReview");
  });
});
