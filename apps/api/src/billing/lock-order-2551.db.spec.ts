/**
 * #2551 / SA-503a (tier 1, lock-order conformance) — TWO real Postgres connections.
 *
 * T2 (a raw pg client) models a Tenant-lock-first ledger writer (reconcilePriceLedger / updatePlan /
 * updateTenantPriceOverride): it takes the Tenant row lock, then — once T1 is waiting on it — writes
 * the TenantSubscription row. T1 is the REAL SubscriptionMutationService.upgrade().
 *
 * Pre-fix, upgrade() wrote the subscription row FIRST and only then touched the Tenant row, so T1
 * held the subscription row while waiting on T2's Tenant lock, and T2's subscription write closed the
 * cycle ⇒ 40P01 (one side aborted). With lockTenantForLedger first, T1 queues on the Tenant lock
 * before it touches the subscription row: T2's write proceeds, T2 commits, T1 completes.
 *
 * T2's subscription write touches only a neutral column (the guard never matches on it), so the pin
 * isolates lock order from the optimistic guard. Real PlanCatalogService, ProrationService,
 * BillingEventService; only cache invalidators / Stripe / notifications / the snapshot hook are
 * stubbed. Tenants are throwaway `qa-*` slugs.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { BillingEventService } from "./billing-event.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "#2551 — upgrade() takes the Tenant lock before the subscription row (two real connections)",
  () => {
    let url: string;
    let pool: Pool;
    let prisma: PrismaClient;
    let svc: SubscriptionMutationService;
    const run = randomUUID().slice(0, 8);
    const tenantIds: string[] = [];
    let seq = 0;
    let createdVersionId: string | undefined;
    const stub = () =>
      new Proxy(
        {},
        { get: (_t, k) => (k === "then" ? undefined : jest.fn().mockResolvedValue(undefined)) },
      ) as any;
    const planTransitionStub = {
      isEnabled: () => Promise.resolve(false),
      prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
      onPlanChange: () => Promise.resolve({ action: "none" }),
      transactionOptions: () => undefined,
      invalidateCaches: () => undefined,
    } as any;

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
            { planKey: "SCALE", name: "Scale", monthlyPrice: 499 },
          ],
          addons: [],
        },
        "lock-order-2551.db.spec.ts",
      );
      const catalog = new PlanCatalogService(prisma as any);
      svc = new SubscriptionMutationService(
        prisma as any,
        catalog,
        new ProrationService(prisma as any, catalog),
        { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
        { invalidate: jest.fn() } as any,
        new BillingEventService(prisma as any),
        stub(), // tenantStatus
        stub(), // stripe
        stub(), // billingNotification
        planTransitionStub,
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

    async function activeTenant(label: string): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-b2551-${run}-${seq}-${label}`,
        "lock-order-2551.db.spec.ts",
      );
      const t = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(t.id);
      await prisma.tenantSubscription.create({
        data: { tenantId: t.id, planKey: "STARTER", basePriceSnapshot: 99, discount: 0 } as any,
      });
      return t.id;
    }

    it("T2 holds the Tenant lock and then writes the subscription row ⇒ upgrade() queues, both commit, no 40P01", async () => {
      const t = await activeTenant("upgrade");
      const t2 = new Client({ connectionString: url });
      await t2.connect();
      try {
        await t2.query("BEGIN");
        await t2.query(`SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE`, [t]);
        const t2pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

        const t1 = svc.upgrade(t, "GROWTH", "admin-2551").then(
          () => ({ ok: true as const }),
          (e) => ({ ok: false as const, e }),
        );

        // Entry condition: T1 is really waiting on T2 (the stats snapshot is cleared before every
        // poll — pg_stat_activity is cached inside an open tx, F2's #2506 diagnosis).
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          const r = await pool.query(
            `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid))) AS n`,
            [t2pid],
          );
          blocked = r.rows[0].n > 0;
          if (!blocked) await new Promise((res) => setTimeout(res, 50));
        }
        expect(blocked).toBe(true);

        // The Tenant-lock-first writer's subscription write. Pre-fix this closes the lock cycle.
        await t2.query(
          `UPDATE "TenantSubscription" SET "externalPaymentNotes" = 'b2551' WHERE "tenantId" = $1`,
          [t],
        );
        await t2.query("COMMIT");

        const r1 = await t1;
        if (!r1.ok) throw (r1 as any).e; // surfaces a 40P01 / 500 on T1's side
      } finally {
        await t2.end().catch(() => undefined);
      }

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t } });
      expect(sub.planKey).toBe("GROWTH");
      expect(sub.externalPaymentNotes).toBe("b2551"); // T2's write survived
      const changed = await prisma.billingEvent.count({
        where: { tenantId: t, type: "plan.changed" },
      });
      expect(changed).toBe(1);
    });
  },
);
