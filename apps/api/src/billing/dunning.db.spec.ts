/**
 * SA-733r7 PR-B3 - dunning against real Postgres (DB lane). What the in-memory specs cannot prove:
 *   - the pause CAS is real: two sweeps racing => exactly one pause, exactly one -MRR row;
 *   - a sweep racing `invoice.paid` => the paid side wins, and no pause survives the resume (the ledger nets to 0);
 *   - the stamp is once per invoice under concurrent `invoice.payment_failed` deliveries;
 *   - a tenant with a held catch-up claim is never stamped or paused.
 * Stripe and the notification service are fakes (no network, no mail). Throwaway `qa-*` tenants only.
 * WRITTEN, NOT RUN in the build session that authored it (the heavy slot was busy): run `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingService } from "./billing.service";
import { BillingEventService } from "./billing-event.service";
import { DunningService } from "./dunning.service";
import { pauseTenantTx } from "./dunning-pause";
import { BILLING_EVENTS } from "./plan-catalog.constants";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const OPEN = {
  status: "open",
  amountPaid: 0,
  amountDue: 14900,
  amountRemaining: 14900,
  paymentProcessing: false,
  nextPaymentAttempt: null,
  attemptCount: 3,
  subscriptionId: null,
  hostedInvoiceUrl: "https://pay.example.test/i/x",
};

describeDb("SA-733r7 PR-B3 dunning (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let events: BillingEventService;
  let billing: BillingService;
  let dunning: DunningService;
  let stripeState: { paid: Set<string>; calls: any[] };
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const saved = process.env.BILLING_PAUSE_MODE;

  // 2099 keeps every instant far from real data; 09:00Z is past 03:00 in the UTC fallback zone.
  const SINCE = new Date("2099-11-01T00:00:00Z");
  const NOW = new Date("2099-11-08T09:00:00Z");
  const H = 3_600_000;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    events = new BillingEventService(prisma as any);
    stripeState = { paid: new Set(), calls: [] };
    const stripe: any = {
      isConfigured: true,
      getInvoiceFacts: async (id: string) =>
        stripeState.paid.has(id)
          ? { ...OPEN, status: "paid", amountPaid: 14900, amountRemaining: 0 }
          : OPEN,
      listOpenSubscriptionInvoices: async () => [],
      getSubscription: async () => ({ status: "active" }),
      updateSubscription: async (...a: any[]) => {
        stripeState.calls.push(a);
        return {};
      },
    };
    const notifications: any = {
      notifyDunning: async () => ({ status: "sent", recipients: 1 }),
      recordDunningMilestone: async () => true,
      localDateLabel: async () => "Nov 9, 2099",
    };
    const guard: any = { invalidate: () => undefined };
    dunning = new DunningService(prisma as any, stripe, notifications, guard);
    billing = new BillingService(
      prisma as any,
      stripe,
      {} as any,
      guard,
      events,
      {} as any,
      notifications,
      {} as any,
      {} as any,
      undefined,
      undefined,
      dunning,
    );
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(() => {
    process.env.BILLING_PAUSE_MODE = "enforced";
    stripeState.paid.clear();
    stripeState.calls.length = 0;
  });

  /** A paying tenant 177 h into an overdue clock whose final notice went out 30 h before NOW. */
  async function overdueTenant(tag: string, sub: Record<string, unknown> = {}) {
    const slug = assertTestTenant(`qa-dun-${tag}-${run}`, "dunning.db.spec.ts");
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    const invoiceId = `in_${tag}_${run}`;
    await prisma.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planKey: "GROWTH",
        basePriceSnapshot: 149,
        stripeSubId: `sub_${tag}_${run}`,
        stripeCustomerId: `cus_${tag}_${run}`,
        externalPayment: false,
        pastDueSince: SINCE,
        pastDueInvoiceId: invoiceId,
        ...sub,
      },
    });
    const final = new Date(NOW.getTime() - 30 * H);
    // the notice key is the EPISODE key `<invoiceId>:<pastDueSince ISO>` (SA r-note 3)
    const episode = `${invoiceId}:${SINCE.toISOString()}`;
    await prisma.billingNotificationLog.createMany({
      data: [
        { tenantId: t.id, milestone: "DUNNING_D0", key: episode, sentAt: SINCE },
        { tenantId: t.id, milestone: "DUNNING_D3", key: episode, sentAt: SINCE },
        { tenantId: t.id, milestone: "DUNNING_D6", key: episode, sentAt: final },
        { tenantId: t.id, milestone: "DUNNING_FINAL", key: episode, sentAt: final },
      ],
    });
    return { id: t.id, invoiceId, subId: `sub_${tag}_${run}` };
  }

  const ledger = async (tenantId: string) =>
    (await prisma.billingEvent.findMany({ where: { tenantId } })).filter(
      (e) =>
        e.type === BILLING_EVENTS.SUBSCRIPTION_SUSPENDED ||
        e.type === BILLING_EVENTS.SUBSCRIPTION_RESUMED,
    );
  const tenantRow = (id: string) => prisma.tenant.findUniqueOrThrow({ where: { id } });
  const subRow = (id: string) =>
    prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
  const deps = () => ({
    prisma: prisma as any,
    stripe: {} as any,
    notifications: {} as any,
    logger: console as any,
    transition: (...a: Parameters<BillingService["transitionAndEmit"]>) =>
      billing.transitionAndEmit(...a),
    mode: () => "enforced" as const,
    once: () => true,
    cursors: new Map<string, string>(),
  });

  it("two pause attempts racing: exactly one pauses, one -MRR row, pausedAt set once (CAS count 0 = no pause)", async () => {
    const t = await overdueTenant("race");
    const results = await Promise.all([
      pauseTenantTx(deps(), { tenantId: t.id }, t.invoiceId, NOW),
      pauseTenantTx(deps(), { tenantId: t.id }, t.invoiceId, new Date(NOW.getTime() + 1)),
      pauseTenantTx(deps(), { tenantId: t.id }, t.invoiceId, new Date(NOW.getTime() + 2)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await tenantRow(t.id);
    expect(row.status).toBe("READ_ONLY");
    expect(row.readOnlyReason).toBe("payment_overdue");
    expect((await subRow(t.id)).pausedAt).not.toBeNull();
    const rows = await ledger(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(BILLING_EVENTS.SUBSCRIPTION_SUSPENDED);
    expect(Number(rows[0].amountDelta)).toBe(-149);
  });

  it("a pause whose clock invoice moved on (pastDueInvoiceId != X) pauses nothing", async () => {
    const t = await overdueTenant("moved");
    expect(await pauseTenantTx(deps(), { tenantId: t.id }, "in_other", NOW)).toBe(false);
    expect((await tenantRow(t.id)).status).toBe("ACTIVE");
    expect(await ledger(t.id)).toHaveLength(0);
  });

  it("two sweeps racing: one pause, one -MRR row, one pause_collection call", async () => {
    const t = await overdueTenant("sweeps");
    await Promise.all([dunning.sweep(NOW), dunning.sweep(NOW)]);
    expect((await tenantRow(t.id)).status).toBe("READ_ONLY");
    const rows = (await ledger(t.id)).filter(
      (e) => e.type === BILLING_EVENTS.SUBSCRIPTION_SUSPENDED,
    );
    expect(rows).toHaveLength(1);
    expect(
      stripeState.calls.filter(
        (c) => c[0] === t.subId && c[1]?.pause_collection?.behavior === "void",
      ),
    ).toHaveLength(1);
  });

  // SMOKE only: Promise.all does not control the interleaving. The guard for the stranded-pause interleaving is the
  // deterministic dunning-race.spec.ts; this proves the same invariants hold against real locks and real rows.
  it("SMOKE: a sweep racing invoice.paid ends consistent - no pause survives the resume and the ledger nets to zero", async () => {
    for (let i = 0; i < 4; i++) {
      const t = await overdueTenant(`paid${i}`);
      // Stripe still shows the invoice OPEN to the sweep (so it tries to pause) while invoice.paid is delivered.
      const invoice = {
        id: t.invoiceId,
        customer: `cus_paid${i}_${run}`,
        parent: { subscription_details: { subscription: t.subId } },
      };
      await Promise.all([dunning.sweep(NOW), dunning.onInvoicePaid(invoice, NOW)]);

      const row = await tenantRow(t.id);
      const sub = await subRow(t.id);
      expect(row.status).toBe("ACTIVE");
      expect(row.readOnlyReason).toBeNull();
      expect(sub.pastDueInvoiceId).toBeNull();
      expect(sub.pausedAt).toBeNull();
      const net = (await ledger(t.id)).reduce((s, e) => s + Number(e.amountDelta ?? 0), 0);
      expect(net).toBe(0); // either never paused, or -149 then +149
    }
  });

  it("concurrent invoice.payment_failed deliveries stamp the clock once; a later invoice leaves the older clock", async () => {
    const t = await overdueTenant("stamp", { pastDueSince: null, pastDueInvoiceId: null });
    const invoice = (id: string) => ({
      id,
      customer: `cus_stamp_${run}`,
      parent: { subscription_details: { subscription: t.subId } },
    });
    const first = new Date("2099-12-01T00:00:00Z");
    await Promise.all([
      dunning.onPaymentFailed(invoice("in_a"), first),
      dunning.onPaymentFailed(invoice("in_a"), new Date(first.getTime() + 5)),
      dunning.onPaymentFailed(invoice("in_b"), new Date(first.getTime() + 9)),
    ]);
    const sub = await subRow(t.id);
    expect(["in_a", "in_b"]).toContain(sub.pastDueInvoiceId);
    // whichever won, the clock is stamped exactly once and stays put
    const winner = sub.pastDueInvoiceId!;
    const since = sub.pastDueSince;
    await dunning.onPaymentFailed(invoice("in_c"), new Date(first.getTime() + 99_000));
    const after = await subRow(t.id);
    expect(after.pastDueInvoiceId).toBe(winner);
    expect(after.pastDueSince).toEqual(since);
  });

  it("a held catch-up claim: never stamped, never swept, never paused", async () => {
    const t = await overdueTenant("claim", { catchupState: "AWAITING_FIRST_PAYMENT" });
    await dunning.sweep(NOW);
    expect((await tenantRow(t.id)).status).toBe("ACTIVE");
    expect(await ledger(t.id)).toHaveLength(0);
    const fresh = await overdueTenant("claim2", {
      catchupState: "SESSION_OPEN",
      pastDueSince: null,
      pastDueInvoiceId: null,
    });
    const out = await dunning.onPaymentFailed(
      {
        id: "in_z",
        customer: `cus_claim2_${run}`,
        parent: { subscription_details: { subscription: fresh.subId } },
      },
      NOW,
    );
    expect(out).toBe("skipped");
    expect((await subRow(fresh.id)).pastDueInvoiceId).toBeNull();
  });

  it("a manual-pay tenant (externalPayment) is never stamped or swept", async () => {
    const t = await overdueTenant("manual", { externalPayment: true });
    await dunning.sweep(NOW);
    expect((await tenantRow(t.id)).status).toBe("ACTIVE");
    const none = await overdueTenant("manual2", {
      externalPayment: true,
      pastDueSince: null,
      pastDueInvoiceId: null,
    });
    expect(
      await dunning.onPaymentFailed(
        {
          id: "in_m",
          customer: `cus_manual2_${run}`,
          parent: { subscription_details: { subscription: none.subId } },
        },
        NOW,
      ),
    ).toBe("skipped");
  });
});
