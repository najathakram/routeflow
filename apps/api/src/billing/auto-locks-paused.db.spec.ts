/**
 * SA-775 (row 381, P0 for the Oct-13 rollout) - the pause on AUTOMATIC tenant locks, against real Postgres.
 *
 * What a mock cannot prove: the gate sits BEFORE the real status write in every automatic writer, a held
 * lock leaves no side effect behind (no add-on deactivation, no notice, no MRR row), the skip record is ONE
 * durable claim + ONE audit row however many hourly passes meet the same case, and the unpaused path (and
 * every non-PRODUCTION class) still locks exactly as before. The switch is the real `AutoLockSwitchService`
 * over the real `PlatformConfig` table (its original row is restored afterwards).
 *
 * Writers exercised through their real entry points: `BillingCronService.expireTrials` /
 * `applyScheduledCancellations`, `BillingService.suspendOverdueTenants` and the `customer.subscription.deleted`
 * webhook (`cancelFromStripe`), `DunningService.sweep` (the `enforced` pause), and
 * `SubscriptionMutationService.cancel` (a tenant admin's own trial cancel). A manual super-admin lock
 * (`PlatformAdminService.updateStatus`) must keep working while paused.
 *
 * Throwaway `qa-*` tenants only; `Tenant.class` is set explicitly on every one (the gate keys off it). The
 * advisory cron lock is a pass-through (the tick is invoked directly). The sweeps scan the whole scratch DB,
 * so every assertion is scoped to this run's tenant ids.
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
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingCronService } from "./billing-cron.service";
import { BillingService } from "./billing.service";
import { BillingEventService } from "./billing-event.service";
import { DunningService } from "./dunning.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
import { AUTO_LOCKS_PAUSED_KEY, AUTO_LOCK_SKIP_AUDIT_ACTION } from "./auto-lock-gate";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { MrrService } from "./mrr.service";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "auto-locks-paused.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;
const H = 3_600_000;

describeDb("SA-775 automatic locks pause (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let sw: AutoLockSwitchService;
  let cron: BillingCronService;
  let billing: BillingService;
  let dunning: DunningService;
  let mutations: SubscriptionMutationService;
  let admin: PlatformAdminService;
  let originalSwitch: { value: string } | null = null;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  const saved = process.env.BILLING_PAUSE_MODE;
  const notifyTrialEnding = jest.fn().mockResolvedValue(undefined);
  const notifyCancelled = jest.fn().mockResolvedValue(undefined);
  const notifySuspended = jest.fn().mockResolvedValue(undefined);
  const stripeSubs = new Map<string, string>(); // subId -> Stripe status for the overdue check
  const stripe: any = {
    isConfigured: true,
    getSubscription: jest.fn(async (id: string) => ({ status: stripeSubs.get(id) ?? "active" })),
    retrieveSubscriptionWithDiscounts: jest
      .fn()
      .mockResolvedValue({ status: "canceled", discounts: [] }),
    previewNextInvoice: jest.fn().mockResolvedValue(null),
    updateSubscription: jest.fn().mockResolvedValue({}),
    getInvoiceFacts: jest.fn(async () => ({
      status: "open",
      amountPaid: 0,
      amountDue: 14900,
      amountRemaining: 14900,
      paymentProcessing: false,
      nextPaymentAttempt: null,
      attemptCount: 3,
      subscriptionId: null,
      hostedInvoiceUrl: "https://pay.example.test/i/x",
    })),
    listOpenSubscriptionInvoices: jest.fn(async () => []),
  };
  const guard: any = { invalidate: jest.fn() };
  const noop: any = { invalidate: jest.fn() };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    originalSwitch = await prisma.platformConfig.findUnique({
      where: { key: AUTO_LOCKS_PAUSED_KEY },
      select: { value: true },
    });
    sw = new AutoLockSwitchService(prisma as any);
    const events = new BillingEventService(prisma as any);
    cron = new BillingCronService(
      prisma as any,
      events,
      noop,
      noop,
      {} as any, // catalog
      {} as any, // meters
      { notifyTrialEnding } as any,
      {} as any, // planTransition
      {} as any, // stripe
      {} as any, // scheduledPrice
      sw,
    );
    const notifications: any = {
      notifyCancelled,
      notifySuspended,
      notifyDunning: async () => ({ status: "sent", recipients: 1 }),
      recordDunningMilestone: async () => true,
      localDateLabel: async () => "Nov 9, 2099",
    };
    dunning = new DunningService(prisma as any, stripe, notifications, guard, sw);
    billing = new BillingService(
      prisma as any,
      stripe,
      { send: jest.fn().mockResolvedValue({}) } as any,
      guard,
      events,
      {} as any, // pricing
      notifications,
      { isEnabled: () => Promise.resolve(false) } as any, // planTransition
      {} as any, // mutations
      undefined,
      undefined,
      dunning,
      sw,
    );
    mutations = new SubscriptionMutationService(
      prisma as any,
      {} as any, // catalog
      {} as any, // proration
      {} as any, // subscription
      noop, // entitlements
      events,
      guard, // tenantStatus
      {} as any, // stripe
      notifications,
      {} as any, // planTransition
      undefined,
      undefined,
      sw,
    );
    admin = new PlatformAdminService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      events,
      {} as any,
      guard,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      new MrrService(prisma as any),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
    if (originalSwitch) {
      await prisma.platformConfig.upsert({
        where: { key: AUTO_LOCKS_PAUSED_KEY },
        create: { key: AUTO_LOCKS_PAUSED_KEY, value: originalSwitch.value },
        update: { value: originalSwitch.value },
      });
    } else {
      await prisma.platformConfig.deleteMany({ where: { key: AUTO_LOCKS_PAUSED_KEY } });
    }
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stripeSubs.clear();
    process.env.BILLING_PAUSE_MODE = "enforced";
  });

  /** "missing" = no PlatformConfig row at all (the default state of a fresh database). */
  async function setSwitch(state: "paused" | "unpaused" | "missing") {
    if (state === "missing") {
      await prisma.platformConfig.deleteMany({ where: { key: AUTO_LOCKS_PAUSED_KEY } });
    } else {
      await sw.setPaused(state === "paused", `db spec ${state}`, null);
    }
    sw.invalidate();
  }

  async function mkTenant(
    label: string,
    cls: TenantClass,
    status: TenantStatus,
    extra: Record<string, unknown> = {},
  ) {
    seq += 1;
    const slug = assertTestTenant(`qa-sa775-${run}-${seq}-${label}`, SPEC);
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: cls, status, ...extra } as any,
    });
    tenantIds.push(t.id);
    return t.id;
  }

  const mkSub = (tenantId: string, extra: Record<string, unknown> = {}) =>
    prisma.tenantSubscription.create({
      data: {
        tenantId,
        planKey: "GROWTH",
        basePriceSnapshot: 249,
        discount: 0,
        ...extra,
      } as any,
    });

  const tenantRow = (id: string) => prisma.tenant.findUniqueOrThrow({ where: { id } });
  const claims = (tenantId: string, kind: string) =>
    prisma.billingNotificationLog.findMany({
      where: { tenantId, milestone: `AUTO_LOCK_PAUSED:${kind}` },
    });
  const audits = (tenantId: string) =>
    prisma.auditLog.findMany({ where: { tenantId, action: AUTO_LOCK_SKIP_AUDIT_ACTION } });
  const events = (tenantId: string, type: string) =>
    prisma.billingEvent.findMany({ where: { tenantId, type } });

  // ─── row 1: expireTrials ────────────────────────────────────────────────────

  describe("expireTrials", () => {
    const trialEnd = () => new Date(Date.now() - 2 * DAY);

    it("PRODUCTION expired trial, paused: NOT locked; three hourly runs leave ONE claim and ONE audit row", async () => {
      await setSwitch("paused");
      const endsAt = trialEnd();
      const t = await mkTenant("trial-prod", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
        trialEndsAt: endsAt,
      });
      await cron.expireTrials();
      await cron.expireTrials();
      await cron.expireTrials();

      const row = await tenantRow(t);
      expect(row.status).toBe("TRIAL");
      expect(row.readOnlyReason).toBeNull();
      expect(await events(t, BILLING_EVENTS.TRIAL_EXPIRED)).toHaveLength(0);
      const c = await claims(t, "trial_expired");
      expect(c).toHaveLength(1);
      expect(c[0].key).toBe(endsAt.toISOString());
      const a = await audits(t);
      expect(a).toHaveLength(1);
      expect(a[0].meta).toMatchObject({
        kind: "trial_expired",
        wouldHaveSet: { status: "READ_ONLY", readOnlyReason: "trial_expired" },
        reason: "paused by rollout switch",
      });
      expect(notifyTrialEnding).not.toHaveBeenCalledWith(t, expect.anything(), expect.anything());
    });

    it("PRODUCTION expired trial, switch key MISSING: treated as PAUSED (no PlatformConfig row)", async () => {
      await setSwitch("missing");
      expect(await prisma.platformConfig.count({ where: { key: AUTO_LOCKS_PAUSED_KEY } })).toBe(0);
      const t = await mkTenant("trial-missing", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
        trialEndsAt: trialEnd(),
      });
      await cron.expireTrials();
      expect((await tenantRow(t)).status).toBe("TRIAL");
      expect(await claims(t, "trial_expired")).toHaveLength(1);
    });

    it("TEST / DEMO / INTERNAL expired trials still lock while paused (QA keeps exercising the locks)", async () => {
      await setSwitch("paused");
      for (const cls of [TenantClass.TEST, TenantClass.DEMO, TenantClass.INTERNAL]) {
        const t = await mkTenant(`trial-${cls}`, cls, TenantStatus.TRIAL, {
          trialEndsAt: trialEnd(),
        });
        await cron.expireTrials();
        const row = await tenantRow(t);
        expect(row.status).toBe("READ_ONLY");
        expect(row.readOnlyReason).toBe("trial_expired");
        expect(await claims(t, "trial_expired")).toHaveLength(0);
      }
    });

    it("unpaused: PRODUCTION locks, and a second run is a no-op (the CAS - one trial.expired, one notice)", async () => {
      await setSwitch("unpaused");
      const endsAt = trialEnd();
      const t = await mkTenant("trial-unpaused", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
        trialEndsAt: endsAt,
      });
      await cron.expireTrials();
      await cron.expireTrials();
      const row = await tenantRow(t);
      expect(row.status).toBe("READ_ONLY");
      expect(row.readOnlyReason).toBe("trial_expired");
      expect(await events(t, BILLING_EVENTS.TRIAL_EXPIRED)).toHaveLength(1);
      expect(notifyTrialEnding.mock.calls.filter((c) => c[0] === t)).toHaveLength(1);
      expect(await claims(t, "trial_expired")).toHaveLength(0);
    });

    it("a trial that lost the race (activated between the scan and the write) is not written over: the CAS matches nothing", async () => {
      await setSwitch("unpaused");
      const t = await mkTenant("trial-raced", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
        trialEndsAt: trialEnd(),
      });
      // a prisma facade whose scan returns the trial row and THEN activates the tenant (the concurrent subscribe)
      const racing = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop !== "tenant") return Reflect.get(target, prop, receiver);
          return {
            findMany: async (args: any) => {
              const rows = await target.tenant.findMany(args);
              if (rows.some((r) => r.id === t)) {
                await target.tenant.update({ where: { id: t }, data: { status: "ACTIVE" } });
              }
              return rows;
            },
            updateMany: (args: any) => target.tenant.updateMany(args),
            update: (args: any) => target.tenant.update(args),
          };
        },
      });
      const racingCron = new BillingCronService(
        racing as any,
        new BillingEventService(prisma as any),
        noop,
        noop,
        {} as any,
        {} as any,
        { notifyTrialEnding } as any,
        {} as any,
        {} as any,
        {} as any,
        sw,
      );
      await racingCron.expireTrials();
      expect((await tenantRow(t)).status).toBe("ACTIVE");
      expect(await events(t, BILLING_EVENTS.TRIAL_EXPIRED)).toHaveLength(0);
      expect(notifyTrialEnding.mock.calls.filter((c) => c[0] === t)).toHaveLength(0);
    });
  });

  // ─── row 2: applyScheduledCancellations ─────────────────────────────────────

  describe("applyScheduledCancellations", () => {
    async function cancelling(label: string, cls: TenantClass) {
      const t = await mkTenant(label, cls, TenantStatus.ACTIVE);
      const periodEnd = new Date(Date.now() - DAY);
      await mkSub(t, { cancelAtPeriodEnd: true, periodEnd });
      await prisma.tenantAddon.create({
        data: {
          tenantId: t,
          addonKey: `addon_${run}_${seq}`,
          sku: null,
          active: true,
          priceSnapshot: 10,
        },
      });
      return { t, periodEnd };
    }

    it("PRODUCTION, paused: no READ_ONLY, add-ons stay ACTIVE, cancelAtPeriodEnd stays armed, ONE skip record", async () => {
      await setSwitch("paused");
      const { t, periodEnd } = await cancelling("cancel-prod", TenantClass.PRODUCTION);
      await cron.applyScheduledCancellations();
      await cron.applyScheduledCancellations();
      await cron.applyScheduledCancellations();

      expect((await tenantRow(t)).status).toBe("ACTIVE");
      expect(
        (await prisma.tenantAddon.findMany({ where: { tenantId: t } })).every((a) => a.active),
      ).toBe(true);
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t } });
      expect(sub.cancelAtPeriodEnd).toBe(true);
      expect(await events(t, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toHaveLength(0);
      const c = await claims(t, "subscription_cancelled");
      expect(c).toHaveLength(1);
      expect(c[0].key).toBe(periodEnd.toISOString());
      expect(await audits(t)).toHaveLength(1);
    });

    it("TEST class, paused: still READ_ONLY with its add-ons off", async () => {
      await setSwitch("paused");
      const { t } = await cancelling("cancel-test", TenantClass.TEST);
      await cron.applyScheduledCancellations();
      const row = await tenantRow(t);
      expect(row.status).toBe("READ_ONLY");
      expect(row.readOnlyReason).toBe("subscription_cancelled");
      expect(
        (await prisma.tenantAddon.findMany({ where: { tenantId: t } })).some((a) => a.active),
      ).toBe(false);
    });

    it("unpause: the next pass locks the held PRODUCTION tenant (no case is lost)", async () => {
      await setSwitch("paused");
      const { t } = await cancelling("cancel-resume", TenantClass.PRODUCTION);
      await cron.applyScheduledCancellations();
      expect((await tenantRow(t)).status).toBe("ACTIVE");
      await setSwitch("unpaused");
      await cron.applyScheduledCancellations();
      const row = await tenantRow(t);
      expect(row.status).toBe("READ_ONLY");
      expect(row.readOnlyReason).toBe("subscription_cancelled");
      expect(
        (await prisma.tenantAddon.findMany({ where: { tenantId: t } })).some((a) => a.active),
      ).toBe(false);
    });
  });

  // ─── row 3: suspendOverdueTenants ───────────────────────────────────────────

  describe("suspendOverdueTenants", () => {
    async function overdue(label: string, cls: TenantClass) {
      const t = await mkTenant(label, cls, TenantStatus.ACTIVE);
      const subId = `sub_${run}_${label}`;
      await mkSub(t, {
        stripeSubId: subId,
        stripeCustomerId: `cus_${run}_${label}`,
        periodEnd: new Date(Date.now() - 30 * DAY),
      });
      stripeSubs.set(subId, "canceled");
      return { t, subId };
    }

    it("PRODUCTION, paused: no SUSPENDED, no notice, ONE skip record keyed by the Stripe sub id", async () => {
      await setSwitch("paused");
      const { t, subId } = await overdue("od-prod", TenantClass.PRODUCTION);
      await billing.suspendOverdueTenants();
      await billing.suspendOverdueTenants();
      await billing.suspendOverdueTenants();
      expect((await tenantRow(t)).status).toBe("ACTIVE");
      expect(notifySuspended.mock.calls.filter((c) => c[0] === t)).toHaveLength(0);
      expect(await events(t, BILLING_EVENTS.SUBSCRIPTION_SUSPENDED)).toHaveLength(0);
      const c = await claims(t, "overdue_suspended");
      expect(c).toHaveLength(1);
      expect(c[0].key).toBe(subId);
      expect(await audits(t)).toHaveLength(1);
    });

    it("TEST class, paused: still SUSPENDED; PRODUCTION, unpaused: SUSPENDED", async () => {
      await setSwitch("paused");
      const test = await overdue("od-test", TenantClass.TEST);
      await billing.suspendOverdueTenants();
      expect((await tenantRow(test.t)).status).toBe("SUSPENDED");

      await setSwitch("unpaused");
      const prod = await overdue("od-prod2", TenantClass.PRODUCTION);
      await billing.suspendOverdueTenants();
      expect((await tenantRow(prod.t)).status).toBe("SUSPENDED");
    });
  });

  // ─── row 4: cancelFromStripe (the customer.subscription.deleted webhook) ────

  describe("cancelFromStripe", () => {
    async function stripeTenant(label: string, cls: TenantClass) {
      const t = await mkTenant(label, cls, TenantStatus.ACTIVE);
      const subId = `sub_${run}_${label}`;
      const customerId = `cus_${run}_${label}`;
      await mkSub(t, {
        stripeSubId: subId,
        stripeCustomerId: customerId,
        planKey: "STARTER",
        basePriceSnapshot: 349,
        downgradeToPlanKey: "STARTER",
        downgradeEffectiveAt: new Date(Date.now() + 5 * DAY),
      });
      return { t, subId, customerId };
    }
    const deliver = (s: { subId: string; customerId: string }) =>
      billing.handleWebhookEvent({
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: s.subId, customer: s.customerId } },
      } as any);

    it("PRODUCTION, paused: no CANCELLED, NO cancellation notice, no MRR row; the Stripe facts ARE recorded; one skip record across redeliveries", async () => {
      await setSwitch("paused");
      const s = await stripeTenant("wh-prod", TenantClass.PRODUCTION);
      await deliver(s);
      await deliver(s);

      expect((await tenantRow(s.t)).status).toBe("ACTIVE");
      expect(notifyCancelled).not.toHaveBeenCalled();
      expect(await events(s.t, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toHaveLength(0);
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: s.t } });
      expect(sub.cancelAtPeriodEnd).toBe(true); // the Stripe-side fact is recorded
      expect(sub.downgradeToPlanKey).toBeNull(); // a cancellation still supersedes a scheduled downgrade
      const c = await claims(s.t, "stripe_cancelled");
      expect(c).toHaveLength(1);
      expect(c[0].key).toBe(s.subId);
      expect(await audits(s.t)).toHaveLength(1);
    });

    it("TEST class, paused: still CANCELLED with the notice", async () => {
      await setSwitch("paused");
      const s = await stripeTenant("wh-test", TenantClass.TEST);
      await deliver(s);
      expect((await tenantRow(s.t)).status).toBe("CANCELLED");
      expect(notifyCancelled).toHaveBeenCalledWith(s.t);
    });

    it("PRODUCTION, unpaused: CANCELLED exactly as before", async () => {
      await setSwitch("unpaused");
      const s = await stripeTenant("wh-unpaused", TenantClass.PRODUCTION);
      await deliver(s);
      expect((await tenantRow(s.t)).status).toBe("CANCELLED");
      expect(await events(s.t, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toHaveLength(1);
    });
  });

  // ─── row 5: the dunning pause ───────────────────────────────────────────────

  describe("dunning pause (BILLING_PAUSE_MODE=enforced)", () => {
    const SINCE = new Date("2099-11-01T00:00:00Z");
    const NOW = new Date("2099-11-08T09:00:00Z");

    async function overdueDunning(label: string, cls: TenantClass) {
      const t = await mkTenant(label, cls, TenantStatus.ACTIVE);
      const invoiceId = `in_${label}_${run}`;
      await mkSub(t, {
        planKey: "GROWTH",
        basePriceSnapshot: 149,
        stripeSubId: `sub_${label}_${run}`,
        stripeCustomerId: `cus_${label}_${run}`,
        externalPayment: false,
        pastDueSince: SINCE,
        pastDueInvoiceId: invoiceId,
      });
      const final = new Date(NOW.getTime() - 30 * H);
      const episode = `${invoiceId}:${SINCE.toISOString()}`;
      await prisma.billingNotificationLog.createMany({
        data: [
          { tenantId: t, milestone: "DUNNING_D0", key: episode, sentAt: SINCE },
          { tenantId: t, milestone: "DUNNING_D3", key: episode, sentAt: SINCE },
          { tenantId: t, milestone: "DUNNING_D6", key: episode, sentAt: final },
          { tenantId: t, milestone: "DUNNING_FINAL", key: episode, sentAt: final },
        ],
      });
      return { t, invoiceId };
    }

    it("PRODUCTION, paused: no pause (still ACTIVE, pausedAt null, no Stripe pause_collection), ONE skip record", async () => {
      await setSwitch("paused");
      const d = await overdueDunning("dun-prod", TenantClass.PRODUCTION);
      await dunning.sweep(NOW);
      await dunning.sweep(NOW);
      await dunning.sweep(NOW);

      const row = await tenantRow(d.t);
      expect(row.status).toBe("ACTIVE");
      expect(row.readOnlyReason).toBeNull();
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: d.t } });
      expect(sub.pausedAt).toBeNull();
      expect(
        stripe.updateSubscription.mock.calls.filter((c: any[]) => c[1]?.pause_collection),
      ).toHaveLength(0);
      expect(await events(d.t, BILLING_EVENTS.SUBSCRIPTION_SUSPENDED)).toHaveLength(0);
      const c = await claims(d.t, "payment_overdue");
      expect(c).toHaveLength(1);
      expect(c[0].key).toBe(d.invoiceId);
      expect(await audits(d.t)).toHaveLength(1);
    });

    it("TEST class, paused: still paused (READ_ONLY payment_overdue); PRODUCTION after unpause: paused", async () => {
      await setSwitch("paused");
      const test = await overdueDunning("dun-test", TenantClass.TEST);
      const prod = await overdueDunning("dun-prod2", TenantClass.PRODUCTION);
      await dunning.sweep(NOW);
      expect((await tenantRow(test.t)).status).toBe("READ_ONLY");
      expect((await tenantRow(prod.t)).status).toBe("ACTIVE");
      await setSwitch("unpaused");
      await dunning.sweep(NOW);
      const row = await tenantRow(prod.t);
      expect(row.status).toBe("READ_ONLY");
      expect(row.readOnlyReason).toBe("payment_overdue");
    });
  });

  // ─── row 6: a tenant admin's own trial cancel ───────────────────────────────

  describe("tenant-admin trial cancel", () => {
    it("PRODUCTION, paused: NOT locked at once; the intent is recorded (skip claim + audit with the actor), trialEndsAt kept", async () => {
      await setSwitch("paused");
      const endsAt = new Date(Date.now() + 5 * DAY);
      const t = await mkTenant("tc-prod", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
        trialEndsAt: endsAt,
      });
      const r1 = await mutations.cancel(t, "user-1");
      const r2 = await mutations.cancel(t, "user-1");
      expect(r1).toEqual({ cancelled: "trial_recorded" });
      expect(r2).toEqual({ cancelled: "trial_recorded" });

      const row = await tenantRow(t);
      expect(row.status).toBe("TRIAL");
      expect(row.readOnlyReason).toBeNull();
      expect(row.trialEndsAt?.getTime()).toBe(endsAt.getTime());
      expect(await events(t, BILLING_EVENTS.TRIAL_CANCELLED)).toHaveLength(0);
      const c = await claims(t, "trial_cancelled");
      expect(c).toHaveLength(1);
      expect(c[0].key).toBe(endsAt.toISOString());
      const a = await audits(t);
      expect(a).toHaveLength(1);
      expect(a[0].userId).toBe("user-1");
    });

    it("TEST class, paused: still READ_ONLY(trial_cancelled) at once; PRODUCTION unpaused likewise", async () => {
      await setSwitch("paused");
      const test = await mkTenant("tc-test", TenantClass.TEST, TenantStatus.TRIAL, {
        trialEndsAt: new Date(Date.now() + 5 * DAY),
      });
      expect(await mutations.cancel(test, "user-1")).toEqual({ cancelled: "trial" });
      expect((await tenantRow(test)).readOnlyReason).toBe("trial_cancelled");

      await setSwitch("unpaused");
      const prod = await mkTenant("tc-prod2", TenantClass.PRODUCTION, TenantStatus.TRIAL, {
        trialEndsAt: new Date(Date.now() + 5 * DAY),
      });
      expect(await mutations.cancel(prod, "user-1")).toEqual({ cancelled: "trial" });
      expect((await tenantRow(prod)).status).toBe("READ_ONLY");
    });
  });

  // ─── rows 8-9: manual super-admin locks are untouched ───────────────────────

  describe("manual super-admin lock", () => {
    it("updateStatus -> SUSPENDED works while paused (and for a PRODUCTION tenant)", async () => {
      await setSwitch("paused");
      const t = await mkTenant("manual", TenantClass.PRODUCTION, TenantStatus.ACTIVE);
      await mkSub(t);
      const res = await admin.updateStatus(t, { status: "SUSPENDED" } as any, "admin-1");
      expect(res.status).toBe("SUSPENDED");
      expect((await tenantRow(t)).status).toBe("SUSPENDED");
      expect(await claims(t, "overdue_suspended")).toHaveLength(0);
    });
  });
});
