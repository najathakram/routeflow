/**
 * W3 / M1 - the platform dashboard's sign-up funnel, driven through the REAL `PlatformAdminService._weeklyFunnel` on Postgres.
 * The unit spec (platform-admin.service.spec.ts) pins the query arguments; this one pins what Postgres does with them:
 *
 *   signups       live tenants, counted in the UTC Monday-start week they were created (edge instants included)
 *   verified      a `user.activate` audit row whose JSON `meta.reason` is `email_verify`; one tenant counts once, in the
 *                 week of its first verification; an admin reactivation or a login that carries the same reason does not
 *   firstOrder    sign-up cohort tenants only (created inside the window); the earliest order must fall inside the window
 *   firstRoute    the same two bounds on routes
 *   demoBookings  bookings by the week they were made
 *
 * "Live" is `class: PRODUCTION` and not soft-deleted: TEST, DEMO, INTERNAL and deleted tenants add nothing to any column.
 * Every number is a DELTA against a funnel read before the spec's rows go in, so the lane's database may hold other data.
 * Throwaway `qa-w3funnel-*` tenants (assertTestTenant), every row removed by id afterwards. DB lane.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PlatformAdminService } from "./platform-admin.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "platform-admin-weekly-funnel.db.spec.ts";
/** Wednesday 2026-11-04: its week starts Monday 2026-11-02, so the eight weeks start 2026-09-14. */
const NOW = new Date("2026-11-04T12:00:00.000Z");
const WEEK_STARTS = [
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
  "2026-11-02",
];
type Week = {
  weekStart: string;
  signups: number;
  verified: number;
  firstOrder: number;
  firstRoute: number;
  demoBookings: number;
};
type Column = keyof Omit<Week, "weekStart">;
const COLUMNS: Column[] = ["signups", "verified", "firstOrder", "firstRoute", "demoBookings"];

describeDb("W3 weekly sign-up funnel (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: PlatformAdminService;
  const run = randomUUID().slice(0, 8);
  let seq = 0;
  const ids = {
    tenant: [] as string[],
    user: [] as string[],
    customer: [] as string[],
    order: [] as string[],
    route: [] as string[],
    audit: [] as string[],
    booking: [] as string[],
  };
  const at = (iso: string) => new Date(iso);

  const funnel = async (): Promise<Week[]> =>
    ((svc as any)._weeklyFunnel(NOW) as Promise<{ weeks: Week[] }>).then((r) => r.weeks);
  /** The funnel now minus the funnel before the spec's rows, per week and column. */
  const delta = (before: Week[], after: Week[]) =>
    Object.fromEntries(
      COLUMNS.map((c) => [c, after.map((w, i) => w[c] - before[i][c])] as [Column, number[]]),
    ) as Record<Column, number[]>;
  /** A column's expected delta: `{ weekIndex: count }`, every other week 0. */
  const weeks = (counts: Record<number, number>) => WEEK_STARTS.map((_, i) => counts[i] ?? 0);

  async function tenant(
    createdAt: string,
    over: { class?: "PRODUCTION" | "TEST" | "DEMO" | "INTERNAL"; deletedAt?: Date } = {},
  ) {
    seq += 1;
    const slug = assertTestTenant(`qa-w3funnel-${run}-${seq}`, SPEC);
    const t = await prisma.tenant.create({
      data: {
        slug,
        name: `Acme ${slug}`,
        class: over.class ?? "PRODUCTION",
        deletedAt: over.deletedAt ?? null,
        createdAt: at(createdAt),
      },
    });
    ids.tenant.push(t.id);
    return t.id;
  }
  async function verified(
    tenantId: string,
    createdAt: string,
    over: { action?: string; reason?: string } = {},
  ) {
    const a = await prisma.auditLog.create({
      data: {
        tenantId,
        action: over.action ?? "user.activate",
        entityType: "User",
        meta: { reason: over.reason ?? "email_verify" },
        createdAt: at(createdAt),
      },
    });
    ids.audit.push(a.id);
  }
  const customerOf = new Map<string, string>();
  async function order(tenantId: string, createdAt: string) {
    let customerId = customerOf.get(tenantId);
    if (!customerId) {
      const user = await prisma.user.create({
        data: {
          email: `buyer@${tenantId}.example.invalid`,
          username: `buyer-${tenantId}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      ids.user.push(user.id);
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: "Acme Buyer", contactName: "Buyer", tenantId },
      });
      ids.customer.push(customer.id);
      customerId = customer.id;
      customerOf.set(tenantId, customerId);
    }
    const o = await prisma.order.create({
      data: { customerId, tenantId, createdAt: at(createdAt) },
    });
    ids.order.push(o.id);
  }
  async function route(tenantId: string, createdAt: string) {
    const r = await prisma.route.create({
      data: { name: "Acme Route", tenantId, createdAt: at(createdAt) },
    });
    ids.route.push(r.id);
  }
  async function booking(createdAt: string) {
    // A confirmed slot is unique by start time, so each booking gets its own slot, years out of any real calendar.
    const slot =
      Date.UTC(2031, 0, 1 + ids.booking.length, 15, 0) + (parseInt(run, 16) % 1000) * 60_000;
    const b = await prisma.demoBooking.create({
      data: {
        name: "Acme Buyer",
        email: `demo-${run}-${ids.booking.length}@example.invalid`,
        company: "Acme",
        startsAt: new Date(slot),
        endsAt: new Date(slot + 30 * 60_000),
        timeZone: "America/Chicago",
        manageTokenHash: `w3funnel-${run}-${ids.booking.length}`,
        createdAt: at(createdAt),
      },
    });
    ids.booking.push(b.id);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    const deps: unknown[] = Array.from({ length: 40 }, () => ({}));
    deps[0] = prisma;
    // getStats() also asks the MRR engine; nothing here is about money.
    deps[13] = { computeOverview: jest.fn().mockResolvedValue({ mrr: 0, ledgerMrr: 0 }) };
    svc = new (PlatformAdminService as any)(...deps);
  });

  afterAll(async () => {
    try {
      await prisma.order.deleteMany({ where: { id: { in: ids.order } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids.customer } } });
      await prisma.user.deleteMany({ where: { id: { in: ids.user } } });
      await prisma.route.deleteMany({ where: { id: { in: ids.route } } });
      await prisma.auditLog.deleteMany({ where: { id: { in: ids.audit } } });
      await prisma.demoBooking.deleteMany({ where: { id: { in: ids.booking } } });
      await prisma.tenant.deleteMany({ where: { id: { in: ids.tenant } } });
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });

  it("counts each column in the right UTC week and leaves out everything that is not a live sign-up", async () => {
    const before = await funnel();
    expect(before.map((w) => w.weekStart)).toEqual(WEEK_STARTS);

    // T1 signs up in week 0 and verifies there (a second verification a week later is the same tenant).
    const t1 = await tenant("2026-09-15T10:00:00.000Z");
    await verified(t1, "2026-09-16T09:00:00.000Z");
    await verified(t1, "2026-09-23T09:00:00.000Z");
    await order(t1, "2026-09-24T10:00:00.000Z"); // its first order: week 1
    await order(t1, "2026-10-08T10:00:00.000Z"); // a later order is not a first
    await route(t1, "2026-09-30T10:00:00.000Z"); // week 2

    // T2: week 1, verified there.
    const t2 = await tenant("2026-09-22T10:00:00.000Z");
    await verified(t2, "2026-09-23T09:00:00.000Z");
    await order(t2, "2026-09-22T12:00:00.000Z");

    // T3: week 1. Its only activation is an admin's reactivation, so it was never verified; a route in week 3.
    const t3 = await tenant("2026-09-23T10:00:00.000Z");
    await verified(t3, "2026-09-24T09:00:00.000Z", { reason: "admin_reactivate" });
    await route(t3, "2026-10-07T10:00:00.000Z");

    // T7 / T8: the last instant of Sunday 09-27 is week 1, the first instant of Monday 09-28 is week 2.
    // T7's only audit row carries the verify reason on the wrong action (a login), so it is not a verification.
    const t7 = await tenant("2026-09-27T23:59:59.999Z");
    await verified(t7, "2026-09-28T09:00:00.000Z", { action: "user.login" });
    await tenant("2026-09-28T00:00:00.000Z");

    // T4: this week. Verified, first order and first route all land in the current week.
    const t4 = await tenant("2026-11-03T08:00:00.000Z");
    await verified(t4, "2026-11-03T08:30:00.000Z");
    await order(t4, "2026-11-03T09:00:00.000Z");
    await route(t4, "2026-11-03T09:30:00.000Z");

    // T6: a sign-up whose earliest order is dated before the window (an import): not a first order of the
    // window, and its later in-window order does not become one.
    const t6 = await tenant("2026-09-16T10:00:00.000Z");
    await order(t6, "2026-09-01T10:00:00.000Z");
    await order(t6, "2026-09-30T10:00:00.000Z");

    // An older tenant: signed up before the window, so its first order and route inside it are not sign-ups.
    const older = await tenant("2026-08-01T10:00:00.000Z");
    await order(older, "2026-10-01T10:00:00.000Z");
    await route(older, "2026-10-01T10:00:00.000Z");

    // Not live: every kind of excluded tenant does all of it in week 1 and adds nothing.
    for (const over of [
      { class: "TEST" as const },
      { class: "DEMO" as const },
      { class: "INTERNAL" as const },
      { deletedAt: at("2026-10-01T00:00:00.000Z") },
    ]) {
      const ghost = await tenant("2026-09-22T11:00:00.000Z", over);
      await verified(ghost, "2026-09-22T12:00:00.000Z");
      await order(ghost, "2026-09-22T13:00:00.000Z");
      await route(ghost, "2026-09-22T13:00:00.000Z");
    }

    // Demo bookings by the week they were made; one made before the window is not in it.
    await booking("2026-09-29T10:00:00.000Z");
    await booking("2026-10-03T10:00:00.000Z");
    await booking("2026-10-20T10:00:00.000Z");
    await booking("2026-09-01T10:00:00.000Z");

    expect(delta(before, await funnel())).toEqual({
      // T1, T6 week 0; T2, T3, T7 week 1; T8 week 2; T4 week 7.
      signups: weeks({ 0: 2, 1: 3, 2: 1, 7: 1 }),
      // T1 once (week 0), T2 week 1, T4 week 7.
      verified: weeks({ 0: 1, 1: 1, 7: 1 }),
      // T1 and T2 week 1, T4 week 7.
      firstOrder: weeks({ 1: 2, 7: 1 }),
      // T1 week 2, T3 week 3, T4 week 7.
      firstRoute: weeks({ 2: 1, 3: 1, 7: 1 }),
      // Two in week 2, one in week 5.
      demoBookings: weeks({ 2: 2, 5: 1 }),
    });
  });

  it("getStats() still resolves with the funnel next to the other dashboard reads", async () => {
    const stats = await svc.getStats();
    expect(stats.weeklyFunnel.weeks).toHaveLength(WEEK_STARTS.length);
    expect(stats.weeklyFunnel.weeks.map((w: Week) => Object.keys(w).sort())).toEqual(
      WEEK_STARTS.map(() => [
        "demoBookings",
        "firstOrder",
        "firstRoute",
        "signups",
        "verified",
        "weekStart",
      ]),
    );
  });
});
