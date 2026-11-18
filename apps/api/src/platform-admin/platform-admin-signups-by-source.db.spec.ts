/**
 * Phase 1 - the dashboard's "Sign-ups by source" table, driven through the REAL `PlatformAdminService` on Postgres
 * (a database migrated from this branch, so the `SignupAttribution` table and its relation are the migration's own).
 *
 *   per source   one row per label; each cohort business counted once for sign-up, verified, first order, first invoice
 *                issued, first real payment, and "paying now" (status ACTIVE)
 *   left out     test, demo, internal and deleted tenants; a tenant that signed up before the 8 weeks
 *   weekly       the weekly funnel read through the SAME shared reads gives the same numbers as before (deltas by week)
 *   row          one per tenant (unique), gone with the tenant (cascade)
 *
 * Every number is a DELTA against a read before the spec's rows go in, so the lane's database may hold other data.
 * Throwaway `qa-ssc-*` tenants (assertTestTenant), every row removed by id afterwards. DB lane.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PlatformAdminService } from "./platform-admin.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "platform-admin-signups-by-source.db.spec.ts";
/** Wednesday 2026-11-04: its week starts Monday 2026-11-02, so the eight weeks start 2026-09-14. */
const NOW = new Date("2026-11-04T12:00:00.000Z");
const WEEK_COUNT = 8;

type Row = {
  source: string;
  signups: number;
  verified: number;
  firstOrder: number;
  firstInvoiceSent: number;
  firstPayment: number;
  payingNow: number;
};
type Week = Record<string, number | string>;

describeDb("Phase 1 sign-ups by source (real Postgres)", () => {
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
    invoice: [] as string[],
    payment: [] as string[],
    route: [] as string[],
    audit: [] as string[],
  };
  const at = (iso: string) => new Date(iso);

  async function read() {
    const reads = (svc as any)._funnelTenantReads(NOW);
    const [source, weekly] = await Promise.all([
      (svc as any)._signupsBySource(NOW, reads) as Promise<{ rows: Row[] }>,
      (svc as any)._weeklyFunnel(NOW, reads) as Promise<{ weeks: Week[] }>,
    ]);
    return { rows: source.rows, weeks: weekly.weeks };
  }
  const rowOf = (rows: Row[], label: string): Row =>
    rows.find((r) => r.source === label) ?? {
      source: label,
      signups: 0,
      verified: 0,
      firstOrder: 0,
      firstInvoiceSent: 0,
      firstPayment: 0,
      payingNow: 0,
    };
  const weeksOf = (counts: Record<number, number>) =>
    Array.from({ length: WEEK_COUNT }, (_, i) => counts[i] ?? 0);

  async function tenant(
    createdAt: string,
    over: {
      class?: "PRODUCTION" | "TEST" | "DEMO" | "INTERNAL";
      deletedAt?: Date;
      status?: "TRIAL" | "ACTIVE";
      attribution?: Record<string, string>;
    } = {},
  ) {
    seq += 1;
    const slug = assertTestTenant(`qa-ssc-${run}-${seq}`, SPEC);
    const t = await prisma.tenant.create({
      data: {
        slug,
        name: `Acme ${slug}`,
        class: over.class ?? "PRODUCTION",
        status: over.status ?? "TRIAL",
        deletedAt: over.deletedAt ?? null,
        createdAt: at(createdAt),
        ...(over.attribution ? { signupAttribution: { create: over.attribution } } : {}),
      },
    });
    ids.tenant.push(t.id);
    return t.id;
  }
  async function verified(tenantId: string, createdAt: string) {
    const a = await prisma.auditLog.create({
      data: {
        tenantId,
        action: "user.activate",
        entityType: "User",
        meta: { reason: "email_verify" },
        createdAt: at(createdAt),
      },
    });
    ids.audit.push(a.id);
  }
  const customerOf = new Map<string, string>();
  async function customerIdOf(tenantId: string) {
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
    return customerId;
  }
  async function order(tenantId: string, createdAt: string) {
    const o = await prisma.order.create({
      data: { customerId: await customerIdOf(tenantId), tenantId, createdAt: at(createdAt) },
    });
    ids.order.push(o.id);
  }
  async function route(tenantId: string, createdAt: string) {
    const r = await prisma.route.create({
      data: { name: "Acme Route", tenantId, createdAt: at(createdAt) },
    });
    ids.route.push(r.id);
  }
  async function invoiceAndPayment(tenantId: string, sentAt: string, paidAt: string) {
    seq += 1;
    const i = await prisma.invoice.create({
      data: {
        invoiceNumber: `SSC-${run}-${seq}`,
        customerId: await customerIdOf(tenantId),
        tenantId,
        status: "SENT",
        subtotal: 10,
        total: 10,
        sentAt: at(sentAt),
      },
    });
    ids.invoice.push(i.id);
    const p = await prisma.invoicePayment.create({
      data: {
        invoiceId: i.id,
        tenantId,
        amount: 10,
        method: "CASH",
        status: "PAID",
        createdAt: at(paidAt),
      },
    });
    ids.payment.push(p.id);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    const deps: unknown[] = Array.from({ length: 40 }, () => ({}));
    deps[0] = prisma;
    svc = new (PlatformAdminService as any)(...deps);
  });

  afterAll(async () => {
    try {
      await prisma.invoicePayment.deleteMany({ where: { id: { in: ids.payment } } });
      await prisma.invoice.deleteMany({ where: { id: { in: ids.invoice } } });
      await prisma.order.deleteMany({ where: { id: { in: ids.order } } });
      await prisma.customer.deleteMany({ where: { id: { in: ids.customer } } });
      await prisma.user.deleteMany({ where: { id: { in: ids.user } } });
      await prisma.route.deleteMany({ where: { id: { in: ids.route } } });
      await prisma.auditLog.deleteMany({ where: { id: { in: ids.audit } } });
      await prisma.tenant.deleteMany({ where: { id: { in: ids.tenant } } });
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });

  it("groups the sign-up cohort by source with the funnel's own definitions, and leaves the weekly numbers as they were", async () => {
    const before = await read();
    const ad = `ssc-${run}`;
    const adLabel = `${ad} / cpc`;
    const refLabel = `referral: ${ad}.example.invalid`;

    // A1 and A2 came from the same ad. A1 does everything; A2 only signed up.
    const a1 = await tenant("2026-09-15T10:00:00.000Z", {
      status: "ACTIVE",
      attribution: { utmSource: ad, utmMedium: "cpc", landingPath: "/pricing" },
    });
    await verified(a1, "2026-09-16T09:00:00.000Z");
    await order(a1, "2026-09-24T10:00:00.000Z");
    await invoiceAndPayment(a1, "2026-10-01T10:00:00.000Z", "2026-10-08T10:00:00.000Z");
    await tenant("2026-09-22T10:00:00.000Z", {
      attribution: { utmSource: ad, utmMedium: "cpc" },
    });

    // B has no attribution row (a sign-up from before this change): "Not recorded".
    const b = await tenant("2026-09-23T10:00:00.000Z");
    await verified(b, "2026-09-24T09:00:00.000Z");

    // C came from another site; its first route is the only step.
    const c = await tenant("2026-11-03T08:00:00.000Z", {
      attribution: { referrerHost: `${ad}.example.invalid` },
    });
    await route(c, "2026-11-03T09:00:00.000Z");

    // Not in the cohort: signed up before the eight weeks; test, demo, internal and deleted tenants.
    await tenant("2026-08-01T10:00:00.000Z", { attribution: { utmSource: ad, utmMedium: "cpc" } });
    for (const over of [
      { class: "TEST" as const },
      { class: "DEMO" as const },
      { class: "INTERNAL" as const },
      { deletedAt: at("2026-10-01T00:00:00.000Z") },
    ]) {
      const ghost = await tenant("2026-09-22T11:00:00.000Z", {
        ...over,
        attribution: { utmSource: ad, utmMedium: "cpc" },
      });
      await verified(ghost, "2026-09-22T12:00:00.000Z");
    }

    const after = await read();

    expect(rowOf(after.rows, adLabel)).toEqual({
      source: adLabel,
      signups: 2,
      verified: 1,
      firstOrder: 1,
      firstInvoiceSent: 1,
      firstPayment: 1,
      payingNow: 1,
    });
    expect(rowOf(after.rows, refLabel)).toEqual({
      source: refLabel,
      signups: 1,
      verified: 0,
      firstOrder: 0,
      firstInvoiceSent: 0,
      firstPayment: 0,
      payingNow: 0,
    });
    const notRecordedBefore = rowOf(before.rows, "Not recorded");
    const notRecordedAfter = rowOf(after.rows, "Not recorded");
    expect(notRecordedAfter.signups - notRecordedBefore.signups).toBe(1);
    expect(notRecordedAfter.verified - notRecordedBefore.verified).toBe(1);

    // Sorted by sign-ups, biggest first.
    const counts = after.rows.map((r) => r.signups);
    expect(counts).toEqual([...counts].sort((x, y) => y - x));

    // The weekly funnel, read through the same shared reads, moved by exactly these rows.
    const delta = (key: string) =>
      after.weeks.map((w, i) => (w[key] as number) - (before.weeks[i][key] as number));
    expect(delta("signups")).toEqual(weeksOf({ 0: 1, 1: 2, 7: 1 })); // A1; A2, B; C
    expect(delta("verified")).toEqual(weeksOf({ 0: 1, 1: 1 })); // A1; B
    expect(delta("firstOrder")).toEqual(weeksOf({ 1: 1 })); // A1
    expect(delta("firstRoute")).toEqual(weeksOf({ 7: 1 })); // C
    expect(delta("firstInvoiceSent")).toEqual(weeksOf({ 2: 1 })); // A1
    expect(delta("firstPayment")).toEqual(weeksOf({ 3: 1 })); // A1
  });

  it("keeps one row per tenant and removes it with the tenant", async () => {
    const id = await tenant("2026-09-15T10:00:00.000Z", { attribution: { gclid: "g1" } });
    await expect(
      prisma.signupAttribution.create({ data: { tenantId: id, gclid: "g2" } }),
    ).rejects.toThrow();
    await prisma.tenant.delete({ where: { id } });
    ids.tenant = ids.tenant.filter((t) => t !== id);
    expect(await prisma.signupAttribution.count({ where: { tenantId: id } })).toBe(0);
  });

  it("getStats() carries signupsBySource next to the weekly funnel", async () => {
    (svc as any).mrrService = { computeOverview: jest.fn().mockResolvedValue({ mrr: 0 }) };
    const stats = await svc.getStats();
    if (!("rows" in stats.signupsBySource)) throw new Error("the source read failed");
    expect(stats.weeklyFunnel).toHaveProperty("weeks");
  });
});
