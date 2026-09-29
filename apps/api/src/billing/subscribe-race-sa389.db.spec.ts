/**
 * #2189 / SA-389 (4) + SA-389a (F2 prover, throwaway) — TWO real Postgres connections. T2 (a raw pg
 * client) takes the tenant row lock FIRST; T1 (the REAL SubscriptionMutationService.subscribe()) runs
 * its pre-tx read, then blocks on `lockTenantForLedger`. While T1 waits, T2 commits a change and
 * releases — so the change lands exactly between T1's pre-read and its lock. Real PlanCatalogService,
 * ProrationService, BillingEventService; only cache invalidators / Stripe / notifications are stubbed.
 * Uses the PUBLISHED catalog when one exists, else self-provides STARTER/GROWTH/SCALE (SA-398). Tenants are throwaway `qa-*` slugs.
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

describeDb("SA-389 — subscribe() re-checks under the tenant lock (two real connections)", () => {
  let url: string;
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: SubscriptionMutationService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  // Set only when this spec created the catalog (CI's fresh DB has none, SA-398).
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
      "subscribe-race-sa389.db.spec.ts",
    );
    const catalog = new PlanCatalogService(prisma as any);
    const published = await catalog.getPublishedCatalog();
    for (const k of ["STARTER", "GROWTH", "SCALE"]) {
      expect(published.definitions.find((d: any) => d.planKey === k)).toBeTruthy();
    }
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

  async function trialTenant(label: string, planKey: string): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-f2b2189-${run}-${seq}-${label}`,
      "subscribe-race-sa389.db.spec.ts",
    );
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.TRIAL },
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({
      data: { tenantId: t.id, planKey, basePriceSnapshot: null, discount: 0 } as any,
    });
    return t.id;
  }
  const state = async (tenantId: string) => {
    const [t, s, ev] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true } }),
      prisma.tenantSubscription.findUniqueOrThrow({
        where: { tenantId },
        select: { planKey: true, periodEnd: true, trialConvertedAt: true, basePriceSnapshot: true },
      }),
      prisma.billingEvent.findMany({
        where: { tenantId },
        select: { type: true, amountDelta: true },
      }),
    ]);
    return {
      status: t.status,
      sub: s,
      events: ev.map((e) => ({
        type: e.type,
        amountDelta: e.amountDelta == null ? null : Number(e.amountDelta),
      })),
    };
  };

  /** Hold the tenant row lock on a SECOND connection, start subscribe(), wait until it is blocked on
   *  that lock (pg_stat_activity), run `between` on the lock-holding connection, COMMIT, await T1. */
  async function interleave(tenantId: string, between: (c: Client) => Promise<void>) {
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    try {
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE`, [tenantId]);
      const t2pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const t1 = svc.subscribe(tenantId, { planKey: "GROWTH", cycle: "MONTHLY" as any }).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      );
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const r = await pool.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [t2pid],
        );
        blocked = r.rows[0].n > 0;
        if (!blocked) await new Promise((res) => setTimeout(res, 50));
      }
      expect(blocked).toBe(true); // T1 really is waiting on T2's lock (after its pre-read)
      await between(t2);
      await t2.query("COMMIT");
      return await t1;
    } finally {
      await t2.end();
    }
  }

  it("(a) T2 commits an upgrade (STARTER→SCALE) between T1's pre-read and lock ⇒ T1 409 PLAN_CHANGED_DURING_SUBSCRIBE, no subscription write, no BillingEvent", async () => {
    const t = await trialTenant("a", "STARTER");
    const r = await interleave(t, async (c) => {
      await c.query(`UPDATE "TenantSubscription" SET "planKey" = 'SCALE' WHERE "tenantId" = $1`, [
        t,
      ]);
    });
    expect(r.ok).toBe(false);
    const e: any = (r as any).e;
    expect(e?.getStatus?.() ?? e?.status).toBe(409);
    expect(e?.getResponse?.()).toMatchObject({
      code: "PLAN_CHANGED_DURING_SUBSCRIBE",
      retryable: true,
    });
    const s = await state(t);
    expect(s.sub.planKey).toBe("SCALE"); // T2's value, untouched by T1
    expect(s.sub.periodEnd).toBeNull();
    expect(s.sub.trialConvertedAt).toBeNull();
    expect(s.status).toBe("TRIAL");
    expect(s.events).toHaveLength(0);
  });

  it("SA-389a: the caller's retry after that 409 re-prepares and books the delta EXACTLY once", async () => {
    const t = await trialTenant("a-retry", "STARTER");
    const first = await interleave(t, async (c) => {
      await c.query(`UPDATE "TenantSubscription" SET "planKey" = 'SCALE' WHERE "tenantId" = $1`, [
        t,
      ]);
    });
    expect(first.ok).toBe(false);
    await svc.subscribe(t, { planKey: "GROWTH", cycle: "MONTHLY" as any }); // the retry
    const s = await state(t);
    expect(s.sub.planKey).toBe("GROWTH");
    expect(s.status).toBe("ACTIVE");
    const booked = s.events.filter((e) => e.amountDelta != null && e.amountDelta !== 0);
    expect(booked).toHaveLength(1); // one delta, not two
    expect(booked[0].amountDelta).toBe(Number(s.sub.basePriceSnapshot)); // full base (coming from TRIAL)
  });

  it("(b) T2 converts TRIAL→ACTIVE between the pre-read and the lock ⇒ T1 derives wasTrial=false and writes NO trialConvertedAt", async () => {
    const t = await trialTenant("b", "STARTER");
    const r = await interleave(t, async (c) => {
      await c.query(`UPDATE "Tenant" SET status = 'ACTIVE' WHERE id = $1`, [t]);
    });
    expect(r.ok).toBe(true);
    const s = await state(t);
    expect(s.sub.planKey).toBe("GROWTH");
    expect(s.sub.trialConvertedAt).toBeNull();
  });

  it("(c) control: no interleaved change ⇒ one write, one event, trialConvertedAt set", async () => {
    const t = await trialTenant("c", "STARTER");
    const r = await interleave(t, async () => {});
    expect(r.ok).toBe(true);
    const s = await state(t);
    expect(s.sub.planKey).toBe("GROWTH");
    expect(s.sub.trialConvertedAt).not.toBeNull();
    expect(s.status).toBe("ACTIVE");
    const booked = s.events.filter((e) => e.amountDelta != null && e.amountDelta !== 0);
    expect(booked).toHaveLength(1);
  });
});
