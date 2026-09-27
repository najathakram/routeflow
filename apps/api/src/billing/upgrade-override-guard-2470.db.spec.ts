/**
 * #2470 (Opus (3) on #2458) — real Postgres, two connections. `SubscriptionMutationService.upgrade()`
 * reads the subscription BEFORE its tx, then writes through an optimistic `updateMany` guard. The
 * guard now matches the negotiated fee it read (`priceOverrideMonthly`) as well as the plan key, so a
 * Pricing change committed between the read and the write makes the upgrade LOSE the race (the
 * existing "Plan changed concurrently" 400) instead of writing the old fee back over the new one.
 *
 * ENTRY (asserted, never timed): T2 holds the TenantSubscription row mid-Pricing-change (fee 80 → 120,
 * uncommitted); `upgrade()` has pre-read the committed fee 80 and is BLOCKED on its guarded UPDATE
 * (pg_blocking_pids); only then does T2 commit. Under READ COMMITTED the blocked UPDATE re-checks its
 * WHERE against the committed row: fee 120 ≠ 80 ⇒ count 0 ⇒ 409. Pre-#2470 (guard on planKey alone)
 * it matched and wrote basePriceSnapshot = 80 over the new fee — the stale write this pins against.
 *
 * Real PrismaClient + BillingEventService / PlanCatalogService / ProrationService; stand-ins only for
 * collaborators upgrade() never touches. Throwaway `qa-*` tenant (assertTestTenant). DB lane (F2).
 */
import { randomUUID } from "crypto";
import { Client } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BillingEventService } from "./billing-event.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { MrrService } from "./mrr.service";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2470 upgrade() loses the race to a concurrent Pricing change (real Postgres)", () => {
  let url: string;
  let pool: Pool;
  let prisma: PrismaClient;
  let mutation: SubscriptionMutationService;
  let platformAdmin: PlatformAdminService;
  const tenantIds: string[] = [];
  const run = randomUUID().slice(0, 8);
  let createdVersionId: string | undefined;

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
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const published = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
    if (!published) {
      // int4 column — never derive from Date.now()
      const version =
        ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
      const created = await prisma.planVersion.create({
        data: {
          version,
          status: "PUBLISHED",
          publishedAt: new Date(),
          notes: "qa fixture — created by upgrade-override-guard-2470.db.spec.ts",
          definitions: {
            create: [
              {
                planKey: "STARTER",
                name: "Starter",
                monthlyPrice: 99,
                isCustom: false,
                featureFlags: [],
              },
              {
                planKey: "GROWTH",
                name: "Growth",
                monthlyPrice: 249,
                isCustom: false,
                featureFlags: [],
              },
            ],
          },
        },
      });
      createdVersionId = created.id;
    }
    const catalog = new PlanCatalogService(prisma as any);
    const noop = {} as any;
    // SA-485b (i): the real updatePlan (it never calls the billing service).
    platformAdmin = new PlatformAdminService(
      prisma as any,
      noop, // jwtService
      noop, // config
      noop, // emailService
      noop, // billingService — updatePlan never calls it
      noop, // platformPricingService
      catalog,
      new ProrationService(prisma as any, catalog),
      { invalidate: jest.fn() } as any, // entitlementsService
      new BillingEventService(prisma as any),
      noop, // meterService
      { invalidate: jest.fn() } as any, // tenantStatusGuard
      { log: jest.fn().mockResolvedValue(undefined) } as any, // auditService
      new MrrService(prisma as any),
      noop, // tenantMirror
      noop, // featureOverrides
      planTransitionStub,
    );
    mutation = new SubscriptionMutationService(
      prisma as any,
      catalog,
      new ProrationService(prisma as any, catalog),
      { getSubscription: jest.fn().mockResolvedValue(undefined) } as any, // subscription
      { invalidate: jest.fn() } as any, // entitlementsService
      new BillingEventService(prisma as any),
      { invalidate: jest.fn() } as any, // tenantStatus
      {} as any, // stripe — upgrade() never calls it
      { notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined) } as any, // billingNotification
      planTransitionStub,
    );
  });

  afterAll(async () => {
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    if (createdVersionId) {
      await prisma.planDefinition.deleteMany({ where: { planVersionId: createdVersionId } });
      await prisma.planVersion.delete({ where: { id: createdVersionId } });
    }
    await prisma.$disconnect();
    await pool.end();
  });

  async function overrideTenant(tag: string, fee: number): Promise<string> {
    const slug = assertTestTenant(
      `qa-b2470-${tag}-${run}`,
      "upgrade-override-guard-2470.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(tenant.id);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        planKey: "STARTER",
        basePriceSnapshot: fee,
        priceOverrideMonthly: fee,
        discount: 0,
      },
    });
    return tenant.id;
  }

  it("a Pricing change (80 → 120) committed while upgrade() waits on its guarded write ⇒ 409; the new fee stands", async () => {
    const id = await overrideTenant("race", 80);
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    let r: { ok: boolean; e?: any };
    let blocked = false;
    try {
      await t2.query("BEGIN");
      await t2.query(
        `UPDATE "TenantSubscription" SET "priceOverrideMonthly" = 120, "basePriceSnapshot" = 120 WHERE "tenantId" = $1`,
        [id],
      );
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const p1 = mutation.upgrade(id, "GROWTH", "admin-2470").then(
        () => ({ ok: true }),
        (e: unknown) => ({ ok: false, e }),
      );
      for (let i = 0; i < 800 && !blocked; i++) {
        // T2 polls INSIDE its own open tx, where pg_stat_activity is a cached per-tx snapshot —
        // clear it each poll or the wait is never observed (F2 on #2506).
        await t2.query("SELECT pg_stat_clear_snapshot()");
        const q = await t2.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        );
        blocked = q.rows[0].n > 0;
        if (!blocked) await new Promise((x) => setTimeout(x, 25));
      }
      await t2.query("COMMIT");
      r = await p1;
    } finally {
      await t2.end();
    }
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    expect({
      blocked,
      ok: r.ok,
      status: r.e?.getStatus?.(),
      planKey: sub.planKey,
      fee: Number(sub.priceOverrideMonthly),
      snapshot: Number(sub.basePriceSnapshot),
      planChanged: await prisma.billingEvent.count({
        where: { tenantId: id, type: "plan.changed" },
      }),
    }).toEqual({
      blocked: true,
      ok: false,
      status: 409, // #2470 fold: a guard miss is a concurrency 409
      planKey: "STARTER",
      fee: 120,
      snapshot: 120, // never the stale 80
      planChanged: 0,
    });
  }, 30_000);

  // Opus fold (1): production commits a Pricing change in TWO steps — updateTenantPriceOverride commits
  // the fee, then reconcilePriceLedger writes the snapshot. An upgrade that reads BETWEEN them (fee 120,
  // snapshot 80) must lose to the reconcile's snapshot write, or both book +40 (ledger +80 vs MRR +40).
  it("two-step Pricing (fee committed, snapshot write held) while upgrade() waits ⇒ 409; nothing double-booked", async () => {
    const id = await overrideTenant("twostep", 80);
    // Step 1, committed on its own: the fee (the snapshot still 80 — reconcile has not run).
    await prisma.tenantSubscription.update({
      where: { tenantId: id },
      data: { priceOverrideMonthly: 120 },
    });
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    let r: { ok: boolean; e?: any };
    let blocked = false;
    try {
      // Step 2 held open: the reconcile's snapshot write.
      await t2.query("BEGIN");
      await t2.query(
        `UPDATE "TenantSubscription" SET "basePriceSnapshot" = 120 WHERE "tenantId" = $1`,
        [id],
      );
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const p1 = mutation.upgrade(id, "GROWTH", "admin-2470").then(
        () => ({ ok: true }),
        (e: unknown) => ({ ok: false, e }),
      );
      for (let i = 0; i < 800 && !blocked; i++) {
        await t2.query("SELECT pg_stat_clear_snapshot()");
        const q = await t2.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        );
        blocked = q.rows[0].n > 0;
        if (!blocked) await new Promise((x) => setTimeout(x, 25));
      }
      await t2.query("COMMIT");
      r = await p1;
    } finally {
      await t2.end();
    }
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    expect({
      blocked,
      ok: r.ok,
      status: r.e?.getStatus?.(),
      planKey: sub.planKey,
      fee: Number(sub.priceOverrideMonthly),
      snapshot: Number(sub.basePriceSnapshot),
      planChanged: await prisma.billingEvent.count({
        where: { tenantId: id, type: "plan.changed" },
      }),
    }).toEqual({
      blocked: true,
      ok: false,
      status: 409,
      planKey: "STARTER",
      fee: 120,
      snapshot: 120,
      planChanged: 0,
    });
  }, 30_000);

  // SA-485b (i): the same two-step Pricing race against the ADMIN plan change. updatePlan read fee 120 /
  // snapshot 80, takes the Tenant lock, and blocks on its compare-and-set subscription write while T2
  // holds reconcile's snapshot UPDATE; after T2 commits the CAS misses ⇒ 409, the tx rolls back (the
  // tenant's plan too), the snapshot stays 120 and nothing is booked.
  it("SA-485b: updatePlan blocked at its guarded write while reconcile's snapshot write commits ⇒ 409, nothing booked", async () => {
    const id = await overrideTenant("admin", 80);
    await prisma.tenantSubscription.update({
      where: { tenantId: id },
      data: { priceOverrideMonthly: 120 }, // step 1 of the Pricing change, committed alone
    });
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    let r: { ok: boolean; e?: any };
    let blocked = false;
    try {
      await t2.query("BEGIN");
      await t2.query(
        `UPDATE "TenantSubscription" SET "basePriceSnapshot" = 120 WHERE "tenantId" = $1`,
        [id],
      );
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const p1 = platformAdmin.updatePlan(id, { plan: "GROWTH" } as any, "admin-2470").then(
        () => ({ ok: true }),
        (e: unknown) => ({ ok: false, e }),
      );
      for (let i = 0; i < 800 && !blocked; i++) {
        await t2.query("SELECT pg_stat_clear_snapshot()");
        const q = await t2.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        );
        blocked = q.rows[0].n > 0;
        if (!blocked) await new Promise((x) => setTimeout(x, 25));
      }
      await t2.query("COMMIT");
      r = await p1;
    } finally {
      await t2.end();
    }
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id } });
    expect({
      blocked,
      ok: r.ok,
      status: r.e?.getStatus?.(),
      planKey: sub.planKey,
      tenantPlan: tenant.plan,
      snapshot: Number(sub.basePriceSnapshot),
      planChanged: await prisma.billingEvent.count({
        where: { tenantId: id, type: "plan.changed" },
      }),
    }).toEqual({
      blocked: true,
      ok: false,
      status: 409,
      planKey: "STARTER",
      tenantPlan: "STARTER",
      snapshot: 120,
      planChanged: 0,
    });
  }, 30_000);

  it("control: with no concurrent change the override row upgrades (plan moves, snapshot stays the fee)", async () => {
    const id = await overrideTenant("ctl", 80);
    await mutation.upgrade(id, "GROWTH", "admin-2470");
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
    expect({ planKey: sub.planKey, snapshot: Number(sub.basePriceSnapshot) }).toEqual({
      planKey: "GROWTH",
      snapshot: 80,
    });
  }, 30_000);
});
