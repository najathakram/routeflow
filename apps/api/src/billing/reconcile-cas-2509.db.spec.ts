/**
 * #2509 — real Postgres, two connections. `BillingService.reconcilePriceLedger` (reached through the
 * public `syncStripeSubscriptionPrice`) reads the subscription, compare-and-sets `basePriceSnapshot` on
 * the (planKey, snapshot) it read, and emits PLAN_CHANGED in the SAME transaction.
 *
 * ENTRY (asserted, never timed): T2 holds the TenantSubscription row with an uncommitted write; the
 * reconcile has read the committed row and is BLOCKED on its compare-and-set (pg_blocking_pids; the
 * stats snapshot is cleared before each poll, since T2 polls inside its own open tx). T2 commits; under
 * READ COMMITTED the blocked UPDATE re-checks its WHERE against the committed row.
 *   - A concurrent upgrade (planKey + snapshot moved) ⇒ the CAS misses, the re-read sees another plan
 *     ⇒ the reconcile writes NOTHING and books NOTHING (pre-#2509 it overwrote the upgrade's snapshot
 *     with the old plan's resolved price and booked against a stale base).
 *   - A second Pricing write (snapshot only) ⇒ the CAS misses, the retry nets against the FRESH value.
 * Plus a control. The real BillingService; the Stripe push is a natural no-op (no stripeSubId), and
 * the resolved price is stubbed (the repricing under test). Throwaway `qa-*` tenants. DB lane (F2).
 */
import { randomUUID } from "crypto";
import { Client, Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingService } from "./billing.service";
import { BillingEventService } from "./billing-event.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2509 reconcilePriceLedger compare-and-set (real Postgres, two connections)", () => {
  let url: string;
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: BillingService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  /** The repricing under test: GROWTH resolves to 150. */
  const pricing = {
    resolveTenantPricing: async () => ({
      planKey: "GROWTH",
      planName: "Growth",
      monthly: 150,
      annual: 1500,
      source: "catalog",
      currency: "usd",
    }),
  };
  const planTransition = {
    isEnabled: () => Promise.resolve(false),
    prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
    onPlanChange: () => Promise.resolve({ action: "none" }),
    transactionOptions: () => undefined,
    invalidateCaches: () => undefined,
  };

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    svc = new BillingService(
      prisma as any,
      { isConfigured: true } as any, // no stripeSubId ⇒ no Stripe call
      { send: async () => ({}) } as any,
      { invalidate: () => undefined } as any,
      new BillingEventService(prisma as any),
      pricing as any,
      { notifyCancelled: async () => undefined, notifySuspended: async () => undefined } as any,
      planTransition as any,
    );
  });

  afterAll(async () => {
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
    await pool.end();
  });

  async function growthTenant(tag: string): Promise<string> {
    const slug = assertTestTenant(`qa-b2509-${tag}-${run}`, "reconcile-cas-2509.db.spec.ts");
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(tenant.id);
    await prisma.tenantSubscription.create({
      data: { tenantId: tenant.id, planKey: "GROWTH", basePriceSnapshot: 249, discount: 0 },
    });
    return tenant.id;
  }

  const syncEvents = (tenantId: string) =>
    prisma.billingEvent.findMany({
      where: { tenantId, type: "plan.changed" },
      select: { amountDelta: true, payload: true },
    });

  /** T2 holds `sql` (uncommitted) on the row while the sync's reconcile blocks on its CAS; then commits. */
  async function raceSync(tenantId: string, sql: string) {
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    let blocked = false;
    try {
      await t2.query("BEGIN");
      await t2.query(sql, [tenantId]);
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const p1 = svc.syncStripeSubscriptionPrice(tenantId);
      for (let i = 0; i < 400 && !blocked; i++) {
        await t2.query("SELECT pg_stat_clear_snapshot()");
        const q = await t2.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        );
        blocked = q.rows[0].n > 0;
        if (!blocked) await new Promise((x) => setTimeout(x, 25));
      }
      await t2.query("COMMIT");
      await p1;
    } finally {
      await t2.end();
    }
    return blocked;
  }

  it("a concurrent upgrade (GROWTH 249 → SCALE 499) during the reconcile ⇒ the reconcile writes and books nothing", async () => {
    const id = await growthTenant("upgrade");
    const blocked = await raceSync(
      id,
      `UPDATE "TenantSubscription" SET "planKey" = 'SCALE', "basePriceSnapshot" = 499 WHERE "tenantId" = $1`,
    );
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    expect({
      blocked,
      planKey: sub.planKey,
      snapshot: Number(sub.basePriceSnapshot),
      events: (await syncEvents(id)).length,
    }).toEqual({ blocked: true, planKey: "SCALE", snapshot: 499, events: 0 });
  }, 30_000);

  it("a second Pricing write (snapshot 249 → 200, same plan) during the reconcile ⇒ retried, booked once against 200", async () => {
    const id = await growthTenant("reprice");
    const blocked = await raceSync(
      id,
      `UPDATE "TenantSubscription" SET "basePriceSnapshot" = 200 WHERE "tenantId" = $1`,
    );
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    const events = await syncEvents(id);
    expect({
      blocked,
      snapshot: Number(sub.basePriceSnapshot),
      deltas: events.map((e) => Number(e.amountDelta)),
    }).toEqual({ blocked: true, snapshot: 150, deltas: [-50] });
  }, 30_000);

  it("control: no concurrent write ⇒ snapshot 150, one −99 event", async () => {
    const id = await growthTenant("ctl");
    await svc.syncStripeSubscriptionPrice(id);
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    const events = await syncEvents(id);
    expect({
      snapshot: Number(sub.basePriceSnapshot),
      deltas: events.map((e) => Number(e.amountDelta)),
    }).toEqual({
      snapshot: 150,
      deltas: [-99],
    });
  }, 30_000);
});
