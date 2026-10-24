/**
 * B1116: the staff order detail says whether the order's invoices "need review" — the SAME derived
 * predicate (#3216's `invoicesNeedReview`) that makes Mark Delivered / Generate Invoice answer 409
 * ORDER_INVOICES_NEED_REVIEW, so the office sees the problem before it hits the 409.
 *
 * Pinned here: the flag comes ONLY from that predicate (never from an audit row); it is staff-only
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

function harness(opts: { audit?: AuditRow[]; users?: UserRow[]; customerId?: string } = {}) {
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
  const client = {
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
  return { service, client, auditFindFirst, userFindFirst };
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

  it("carries flagged:false (and never reads the audit trail) when the invoices are in step", async () => {
    predicate.mockResolvedValue(false);
    const { service, auditFindFirst, userFindFirst } = harness({
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
    // A leftover audit row from an earlier episode never turns the badge on.
    expect(out.invoicesNeedReview).toEqual({ flagged: false });
    expect(auditFindFirst).not.toHaveBeenCalled();
    expect(userFindFirst).not.toHaveBeenCalled();
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
