/**
 * #2509 — real Postgres, two connections. `BillingService.reconcilePriceLedger` (reached through the
 * public `syncStripeSubscriptionPrice`) reads the subscription, compare-and-sets `basePriceSnapshot` on
 * the (planKey, snapshot) it read, and emits PLAN_CHANGED in the SAME transaction.
 *
 * ENTRY (asserted, never timed): T2 holds the TenantSubscription row with an uncommitted write; the
 * reconcile has read the committed row and is BLOCKED on its compare-and-set (pg_blocking_pids, polled
 * from the pool until blocked or settled — #2666: condition-based, asserted before T2 is released). T2 commits; under
 * READ COMMITTED the blocked UPDATE re-checks its WHERE against the committed row.
 *   - A concurrent upgrade (planKey + snapshot moved) ⇒ the CAS misses, the re-read sees another plan
 *     ⇒ the reconcile writes NOTHING and books NOTHING (pre-#2509 it overwrote the upgrade's snapshot
 *     with the old plan's resolved price and booked against a stale base).
 *   - A second Pricing write (snapshot only) ⇒ the CAS misses, the retry nets against the FRESH value.
 * SA-503a (#2528 fold): pin 1's T2 runs upgrade()'s real sequence and the Tenant-lock pin runs Pricing's
 * — both take the Tenant lock first, so the reconcile must be waiting on ITS Tenant lock (asserted from
 * pg_locks, structurally — #2666/SA-548: red if that lock is reverted), then complete on the fresh row. Plus a control. The real BillingService; the Stripe push is a natural no-op (no stripeSubId), and
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
      {
        checkoutAddonLines: async () => ({ lineItems: [], skus: [], invalid: [] }),
        adoptCheckoutAddons: async () => undefined,
      } as any, // mutations (SA-690)
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

  /** One session blocked on T2, read STRUCTURALLY from pg_locks (#2666 / SA-548 — never a regex on
   *  query text). A row-lock waiter holds the heavyweight TUPLE lock on the row it waits for (its
   *  ungranted lock is usually T2's transactionid, which names no table), so the relation it waits on is
   *  the relation of its tuple lock. `query` is kept for the failure message only. */
  type Waiter = {
    pid: number;
    query: string;
    waiting: boolean;
    onTenant: boolean;
    onSubscription: boolean;
    locks: unknown;
  };

  async function waitersOn(t2pid: number): Promise<Waiter[]> {
    const q = await pool.query(
      `SELECT a.pid, a.query,
         EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted) AS waiting,
         EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'tuple'
                   AND l.relation = '"Tenant"'::regclass) AS "onTenant",
         EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.locktype = 'tuple'
                   AND l.relation = '"TenantSubscription"'::regclass) AS "onSubscription",
         (SELECT json_agg(json_build_object('locktype', l.locktype, 'relation', l.relation::regclass::text,
                   'mode', l.mode, 'granted', l.granted))
            FROM pg_locks l WHERE l.pid = a.pid) AS locks
       FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))`,
      [t2pid],
    );
    return q.rows as Waiter[];
  }

  const dump = (x: unknown) => JSON.stringify(x, null, 2);

  /** SA-503a / SA-548: the reconcile must be waiting on the TENANT row. A miss throws every blocked
   *  waiter's query + pg_locks rows (a wait on TenantSubscription at HEAD goes to the SA). */
  function expectTenantWait(race: { tenantLock: boolean; waitingOn: unknown }) {
    if (!race.tenantLock) {
      throw new Error(
        `#2666 the reconcile is not waiting on the Tenant row; waitingOn: ${dump(race.waitingOn)}`,
      );
    }
  }

  /** T2 runs `statements` (uncommitted) while the sync's reconcile blocks on T2; then commits.
   *  #2666: the ENTRY is condition-based, never timed. Poll (from the pool, a fresh stats snapshot per
   *  statement, as #2659) until a session is blocked on T2 OR the sync has settled; only a deadline
   *  under the test timeout ends it otherwise, and then it FAILS with what it saw. The entry is asserted
   *  BEFORE T2 is released. SA-503a: the reconcile must be waiting on the TENANT row (pg_locks). */
  async function raceSync(tenantId: string, statements: string[]) {
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    let waiters: Waiter[] = [];
    let settled = false;
    let sync: Promise<unknown> | undefined;
    try {
      await t2.query("BEGIN");
      for (const sql of statements) await t2.query(sql, [tenantId]);
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      sync = svc.syncStripeSubscriptionPrice(tenantId).then(
        () => undefined,
        (e: unknown) => e,
      );
      void sync.then(() => (settled = true));
      const deadline = Date.now() + 25_000;
      while (!waiters.some((w) => w.waiting) && !settled && Date.now() < deadline) {
        waiters = await waitersOn(pid);
        if (!waiters.some((w) => w.waiting) && !settled)
          await new Promise((x) => setTimeout(x, 25));
      }
      // ENTRY, before the release: the sync is blocked on T2 (it cannot finish while T2 holds a lock it
      // needs — settling first would itself be the bug). SA-548 (3): a miss THROWS the full dump —
      // every waiter's query and its pg_locks rows — never a matcher that elides it.
      if (!waiters.some((w) => w.waiting) || settled) {
        throw new Error(
          `#2666 entry not reached (blocked=${waiters.some((w) => w.waiting)}, settledFirst=${settled}); ` +
            `waiters on T2 pid ${pid}: ${dump(waiters)}`,
        );
      }
    } finally {
      await t2.query("COMMIT").catch(() => undefined);
      const err = sync ? await sync : undefined;
      await t2.end().catch(() => undefined);
      if (err) throw err;
    }
    const blocked = waiters.filter((w) => w.waiting);
    return {
      blocked: blocked.length > 0,
      tenantLock: blocked.some((w) => w.onTenant),
      /** Diagnostics for a miss (SA-548: a wait on TenantSubscription here goes to the SA). */
      waitingOn: blocked.map((w) => ({ query: w.query, locks: w.locks })),
    };
  }

  it("a concurrent upgrade (GROWTH 249 → SCALE 499) during the reconcile ⇒ the reconcile writes and books nothing", async () => {
    const id = await growthTenant("upgrade");
    // SA-503a: T2 runs upgrade()'s REAL write sequence (with #2551): the Tenant lock, the guarded
    // subscription UPDATE (plan + snapshot), then the Tenant plan write.
    const race = await raceSync(id, [
      `SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE`,
      `UPDATE "TenantSubscription" SET "planKey" = 'SCALE', "currentPlan" = 'SCALE', "basePriceSnapshot" = 499 WHERE "tenantId" = $1`,
      `UPDATE "Tenant" SET "plan" = 'SCALE' WHERE id = $1`,
    ]);
    expectTenantWait(race); // structural (pg_locks); a miss throws the dump
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    expect({
      blocked: race.blocked,
      planKey: sub.planKey,
      snapshot: Number(sub.basePriceSnapshot),
      events: (await syncEvents(id)).length,
    }).toEqual({
      blocked: true,
      planKey: "SCALE",
      snapshot: 499,
      events: 0,
    });
  }, 30_000);

  it("a second Pricing change (fee, then snapshot 249 → 200, same plan) during the reconcile ⇒ retried, booked once against 200", async () => {
    const id = await growthTenant("reprice");
    // SA-464f: a Pricing change writes the fee and the snapshot in SEPARATE statements, as production
    // does (updateTenantPriceOverride's fee, then reconcile's snapshot); T2 holds both uncommitted.
    const { blocked } = await raceSync(id, [
      `UPDATE "TenantSubscription" SET "priceOverrideMonthly" = 200 WHERE "tenantId" = $1`,
      `UPDATE "TenantSubscription" SET "basePriceSnapshot" = 200 WHERE "tenantId" = $1`,
    ]);
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    const events = await syncEvents(id);
    expect({
      blocked,
      snapshot: Number(sub.basePriceSnapshot),
      deltas: events.map((e) => Number(e.amountDelta)),
    }).toEqual({ blocked: true, snapshot: 150, deltas: [-50] });
  }, 30_000);

  // SA-503a (#2528 fold): T2 is a Tenant-lock-first writer (updateTenantPriceOverride's real
  // sequence: the Tenant lock, the fee, then the snapshot). The reconcile queues on the Tenant lock —
  // before its read — so once T2 commits it reads the FRESH row and books once, with no conflict.
  it("T2 holds the Tenant lock (Pricing: fee, then snapshot 200) ⇒ the reconcile queues on it, completes on the fresh row, books once", async () => {
    const id = await growthTenant("tenantlock");
    const race = await raceSync(id, [
      `SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE`,
      `UPDATE "TenantSubscription" SET "priceOverrideMonthly" = 200 WHERE "tenantId" = $1`,
      `UPDATE "TenantSubscription" SET "basePriceSnapshot" = 200 WHERE "tenantId" = $1`,
    ]);
    expectTenantWait(race); // structural (pg_locks); a miss throws the dump
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    const events = await syncEvents(id);
    expect({
      blocked: race.blocked,
      snapshot: Number(sub.basePriceSnapshot),
      deltas: events.map((e) => Number(e.amountDelta)),
    }).toEqual({
      blocked: true,
      snapshot: 150,
      deltas: [-50],
    });
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
