/**
 * #2641 / SA-544 (tier 1, billing ledger) — the scheduled sweeps re-prove their scan on rows read
 * UNDER the Tenant row lock. TWO real Postgres connections.
 *
 * T2 (a raw pg client) takes the Tenant row lock and SUSPENDS the tenant inside its open tx. The REAL
 * BillingCronService sweep (T1) has already scanned the tenant as ACTIVE (T2's write is uncommitted),
 * so it queues on the Tenant lock. T2 commits; T1 must then see SUSPENDED and skip: no plan/READ_ONLY
 * write, no ledger event, the schedule still armed. Pre-fix the downgrade booked a PLAN_CHANGED Δ and
 * the cancellation wrote READ_ONLY over SUSPENDED and booked a churn Δ.
 *
 * Plus (SA-544 Q2): an ACTIVE TEST-class tenant's scheduled cancellation still goes READ_ONLY and books
 * exactly ONE SUBSCRIPTION_CANCELED event at Δ0.
 *
 * The advisory cron lock is a pass-through (the tick is invoked directly). Real PlanCatalogService and
 * BillingEventService; cache invalidators, meters, notifications and the snapshot hook are stubbed.
 * Tenants are throwaway `qa-*` slugs.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingCronService } from "./billing-cron.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { BillingEventService } from "./billing-event.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "billing-cron-paying-2641.db.spec.ts";

describeDb(
  "#2641 — scheduled billing sweeps re-read under the Tenant lock (two real connections)",
  () => {
    let url: string;
    let pool: Pool;
    let prisma: PrismaClient;
    let cron: BillingCronService;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let seq = 0;
    let createdVersionId: string | undefined;
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

    beforeAll(async () => {
      url = requireLocalDatabaseUrl();
      pool = new Pool({ connectionString: url });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
      createdVersionId = await ensurePublishedCatalog(
        prisma,
        {
          plans: [
            { planKey: "STARTER", name: "Starter", monthlyPrice: 99 },
            { planKey: "GROWTH", name: "Growth", monthlyPrice: 249 },
          ],
          addons: [],
        },
        SPEC,
      );
      const noop = { invalidate: jest.fn() } as any;
      cron = new BillingCronService(
        prisma as any,
        new BillingEventService(prisma as any),
        noop, // entitlements
        noop, // tenantStatus
        new PlanCatalogService(prisma as any),
        { read: jest.fn() } as any, // meters (grace only)
        {
          notifyTrialEnding: jest.fn().mockResolvedValue(undefined),
          notifyDowngradeApplied: jest.fn().mockResolvedValue(undefined),
        } as any,
        {
          isEnabled: () => Promise.resolve(false),
          prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
          onPlanChange: () => Promise.resolve({ action: "none" }),
          transactionOptions: () => undefined,
          invalidateCaches: () => undefined,
        } as any,
      );
    });

    afterAll(async () => {
      if (tenantIds.length) {
        await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
      await dropPublishedCatalog(prisma, createdVersionId);
      await prisma?.$disconnect();
      await pool?.end();
    });

    async function tenant(label: string, cls: TenantClass, sub: Record<string, unknown>) {
      seq += 1;
      const slug = assertTestTenant(`qa-b2641-${run}-${seq}-${label}`, SPEC);
      const t = await prisma.tenant.create({
        data: { slug, name: slug, class: cls, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(t.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: t.id,
          planKey: "GROWTH",
          basePriceSnapshot: 249,
          discount: 0,
          ...sub,
        } as any,
      });
      return t.id;
    }

    /** T2 locks + suspends `t` in an open tx; `sweep` runs, must queue on T2; T2 commits. */
    async function suspendWhileSweepWaits(t: string, sweep: () => Promise<void>) {
      const t2 = new Client({ connectionString: url });
      await t2.connect();
      try {
        await t2.query("BEGIN");
        await t2.query(`SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE`, [t]);
        await t2.query(`UPDATE "Tenant" SET status = 'SUSPENDED' WHERE id = $1`, [t]);
        const t2pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

        const t1 = sweep().then(
          () => ({ ok: true as const }),
          (e) => ({ ok: false as const, e }),
        );

        // Entry condition: the sweep is really waiting on T2's Tenant lock (stats snapshot cleared
        // before every poll — pg_stat_activity is cached inside an open tx, F2's #2506 diagnosis).
        let blocked = false;
        for (let i = 0; i < 200 && !blocked; i++) {
          const r = await pool.query(
            `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
           WHERE $1 = ANY(pg_blocking_pids(pid))) AS n`,
            [t2pid],
          );
          blocked = r.rows[0].n > 0;
          if (!blocked) await new Promise((res) => setTimeout(res, 50));
        }
        expect(blocked).toBe(true);

        await t2.query("COMMIT");
        const r1 = await t1;
        if (!r1.ok) throw (r1 as any).e;
      } finally {
        await t2.end().catch(() => undefined);
      }
    }

    const events = (t: string, type: string) =>
      prisma.billingEvent.findMany({ where: { tenantId: t, type } });

    it("downgrade: a tenant SUSPENDED while the sweep waits on its lock is skipped — no plan write, no plan.changed, still armed", async () => {
      const t = await tenant("downgrade", TenantClass.PRODUCTION, {
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: past,
      });
      await suspendWhileSweepWaits(t, () => cron.applyScheduledDowngrades());

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t } });
      expect(sub.planKey).toBe("GROWTH");
      expect(sub.downgradeToPlanKey).toBe("STARTER"); // still armed
      expect(sub.downgradeEffectiveAt).not.toBeNull();
      expect(await events(t, "plan.changed")).toHaveLength(0);
      const row = await prisma.tenant.findUniqueOrThrow({ where: { id: t } });
      expect(row.status).toBe("SUSPENDED");
    });

    it("cancellation: a tenant SUSPENDED while the sweep waits on its lock stays SUSPENDED — no READ_ONLY, no churn event", async () => {
      const t = await tenant("cancel", TenantClass.PRODUCTION, {
        cancelAtPeriodEnd: true,
        periodEnd: past,
      });
      await suspendWhileSweepWaits(t, () => cron.applyScheduledCancellations());

      const row = await prisma.tenant.findUniqueOrThrow({ where: { id: t } });
      expect(row.status).toBe("SUSPENDED");
      expect(await events(t, "subscription.canceled")).toHaveLength(0);
    });

    it("cancellation: an ACTIVE TEST-class tenant goes READ_ONLY with exactly ONE subscription.canceled at Δ0", async () => {
      const t = await tenant("test-class", TenantClass.TEST, {
        cancelAtPeriodEnd: true,
        periodEnd: past,
      });
      await cron.applyScheduledCancellations();

      const row = await prisma.tenant.findUniqueOrThrow({ where: { id: t } });
      expect(row.status).toBe("READ_ONLY");
      const canceled = await events(t, "subscription.canceled");
      expect(canceled).toHaveLength(1);
      expect(Number(canceled[0].amountDelta)).toBe(0);
    });
  },
);
