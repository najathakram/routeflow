// `@LeaderCron` wraps every cron tick in a Postgres advisory lock (common/cron-lock.ts).
// These specs invoke the tick directly and have no database, so the lock is a PASS-THROUGH here:
// it must still call the body — a mock that skipped it would make every assertion below measure
// a tick that never ran.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { PlanTransitionConfigService } from "./plan-transition-config.service";
import { normalizePlanKey, planKeyFromEnum } from "./plan-catalog.constants";
import { BillingService } from "./billing.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "./stripe.service";
import { EmailService } from "../email/email.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { BillingEventService } from "./billing-event.service";
import { PlatformPricingService } from "./platform-pricing.service";
import { BillingNotificationService } from "./billing-notification.service";

/**
 * MRR-ledger reconciliation for the LEGACY Stripe lifecycle (Plans & Billing P6 follow-up).
 * Stripe churn (cancel/suspend) and reactivation (payment/checkout) must emit SIGNED
 * BillingEvent deltas mirroring MrrService's paying predicate, so `ledgerMrr`/`momDelta` track
 * the snapshot. Each transition is an ATOMIC compare-and-swap on tenant.status inside one
 * transaction — the conditional updateMany (`count === 1`) is the idempotency key, so duplicate /
 * concurrent / reordered webhooks (e.g. the paired checkout + invoice.payment_succeeded) can't
 * double-emit. Gated on `planKey != null` → pure legacy-Stripe tenants (planKey null) are no-ops.
 */
function make(
  overrides: {
    sub?: any;
    addons?: any[];
    stripeStatus?: string;
    /** count returned by the CAS updateMany — 1 = this call won the transition, 0 = lost/no-op. */
    transitionCount?: number;
    /** WP14 (B445): PlatformPricingService stand-in — defaults to a resolvable catalog price. */
    pricing?: any;
    /** count of the checkout's compare-and-swap on the plan (0 = the plan moved concurrently). */
    casCount?: number;
  } = {},
) {
  const sub = overrides.sub ?? {
    tenantId: "t1",
    planKey: "BUSINESS",
    basePriceSnapshot: 349,
    discount: 0,
    stripeSubId: null,
  };
  const tx = {
    tenant: {
      updateMany: jest.fn().mockResolvedValue({ count: overrides.transitionCount ?? 1 }),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(overrides.addons ?? []),
    },
    // onCheckoutCompleted writes the subscription inside a transaction (A2/B593); it is the SAME
    // mock as prisma.tenantSubscription.upsert so every existing assertion on it still holds.
    tenantSubscription: {
      upsert: jest.fn((args: unknown) => prisma.tenantSubscription.upsert(args)),
      updateMany: jest.fn().mockResolvedValue({ count: overrides.casCount ?? 1 }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null), // no processed session in the tx by default
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const prisma = {
    tenant: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ plan: "STARTER", planVersionId: "v1" }),
    },
    tenantSubscription: {
      findFirst: jest.fn().mockResolvedValue(sub),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { ...sub, stripeSubId: "sub_1", tenant: { id: sub.tenantId, slug: "acme" } },
        ]),
      // Finding 4 (Lite-L2 review): onCheckoutCompleted reads this to check for a negotiated
      // price override before overwriting basePriceSnapshot. `sub` has no
      // priceOverrideMonthly/priceOverrideAnnual fields by default, so they read as `undefined`
      // (`undefined != null` is false) — every existing test's hasNegotiatedOverride defaults to
      // false, preserving current behavior exactly.
      findUnique: jest.fn().mockResolvedValue(sub),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue(sub),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(null), // no processed session by default
      create: jest.fn().mockResolvedValue({}),
    },
    tenantFeatureConfigSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
  const stripe = {
    isConfigured: true,
    getSubscription: jest.fn().mockResolvedValue({
      status: overrides.stripeStatus ?? "past_due",
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_000_000,
    }),
  } as any;
  const email = { send: jest.fn().mockResolvedValue({}) } as any;
  const tenantStatus = { invalidate: jest.fn() } as any;
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const pricing = overrides.pricing ?? {
    resolveCatalogPricing: jest.fn().mockResolvedValue({
      planKey: "BUSINESS",
      planName: "Business",
      monthly: 349,
      annual: 3490,
      source: "catalog",
      currency: "usd",
    }),
  };
  const billingNotification = {
    notifyCancelled: jest.fn().mockResolvedValue(undefined),
    notifySuspended: jest.fn().mockResolvedValue(undefined),
    notifyCheckoutPlanNotApplied: jest.fn().mockResolvedValue(undefined),
  } as any;
  const planTransition = {
    isEnabled: jest.fn().mockResolvedValue(true),
    prepare: jest.fn().mockResolvedValue({ enabled: true, planAllows: null }),
    onPlanChange: jest.fn().mockResolvedValue({ action: "none" }),
  } as any;
  const svc = new BillingService(
    prisma,
    stripe,
    email,
    tenantStatus,
    events,
    pricing,
    billingNotification,
    planTransition,
  );
  return {
    svc,
    prisma,
    tx,
    stripe,
    events,
    tenantStatus,
    pricing,
    billingNotification,
    planTransition,
  };
}

const deltaOf = (events: any, type: string) => {
  const c = events.emit.mock.calls.find((x: any[]) => x[1] === type);
  return c ? c[3]?.amountDelta : undefined;
};
const emitted = (events: any) => events.emit.mock.calls.map((c: any[]) => c[1]);

describe("BillingService — Stripe churn/reactivation MRR ledger", () => {
  describe("onSubscriptionDeleted (→ CANCELLED)", () => {
    it("emits a NEGATIVE churn delta via an ACTIVE→CANCELLED CAS for a paying tenant", async () => {
      const { svc, tx, events } = make({
        transitionCount: 1,
        addons: [{ priceSnapshot: 12, quantity: 2 }],
      });
      await (svc as any).onSubscriptionDeleted({ customer: "cus_1" });
      // Atomic compare-and-swap on status is the idempotency key.
      expect(tx.tenant.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: "t1", status: "ACTIVE" },
        data: { status: "CANCELLED" },
      });
      // −(349 base + 12×2 add-ons − 0 discount) = −373, emitted inside the same tx.
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-373);
    });

    it("is a NO-OP delta when the tenant was already non-ACTIVE, but still lands CANCELLED", async () => {
      const { svc, prisma, events } = make({ transitionCount: 0 });
      await (svc as any).onSubscriptionDeleted({ customer: "cus_1" });
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
      // Fallback still forces the terminal CANCELLED status (no duplicate delta).
      expect(prisma.tenant.update.mock.calls[0][0].data).toMatchObject({ status: "CANCELLED" });
    });

    it("emits no delta for a legacy Stripe-only tenant (planKey null) even when the CAS wins", async () => {
      const { svc, events } = make({
        transitionCount: 1,
        sub: { tenantId: "t1", planKey: null, basePriceSnapshot: null, discount: 0 },
      });
      await (svc as any).onSubscriptionDeleted({ customer: "cus_1" });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it("disarms a scheduled downgrade alongside cancelAtPeriodEnd (round 3, finding 10)", async () => {
      const { svc, prisma } = make({ transitionCount: 1 });
      await (svc as any).onSubscriptionDeleted({ customer: "cus_1" });
      // A cancellation SUPERSEDES a scheduled downgrade — cancel()'s own rule. Left armed, the
      // 02:00 sweep re-prices basePriceSnapshot on an already-churned tenant and books a second
      // PLAN_CHANGED delta on top of the churn delta emitted here.
      expect(prisma.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
        cancelAtPeriodEnd: true,
        downgradeToPlanKey: null,
        downgradeEffectiveAt: null,
        retainedUserIds: [],
      });
    });

    it("N3: notifies the tenant admin of the cancellation, after the DB writes above", async () => {
      const { svc, billingNotification } = make({ transitionCount: 1 });
      await (svc as any).onSubscriptionDeleted({ customer: "cus_1" });
      expect(billingNotification.notifyCancelled).toHaveBeenCalledWith("t1");
    });

    it("N3: a rejected notifyCancelled never blocks the cancellation — onSubscriptionDeleted still resolves", async () => {
      const { svc, billingNotification } = make({ transitionCount: 1 });
      billingNotification.notifyCancelled.mockRejectedValueOnce(new Error("email down"));
      await expect(
        (svc as any).onSubscriptionDeleted({ customer: "cus_1" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("onSubscriptionUpdated (round 3, finding 10)", () => {
    const evt = (cancelAtPeriodEnd: boolean) => ({
      customer: "cus_1",
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_000_000,
      cancel_at_period_end: cancelAtPeriodEnd,
    });

    it("clears the downgrade markers when the update ARMS a cancellation", async () => {
      const { svc, prisma } = make();
      await (svc as any).onSubscriptionUpdated(evt(true));
      expect(prisma.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
        cancelAtPeriodEnd: true,
        downgradeToPlanKey: null,
        downgradeEffectiveAt: null,
        retainedUserIds: [],
      });
    });

    it("leaves the downgrade markers untouched on an ordinary update", async () => {
      const { svc, prisma } = make();
      await (svc as any).onSubscriptionUpdated(evt(false));
      // A cycle roll, a price sync or an add-on item arrives as subscription.updated too —
      // clearing the markers there would silently drop a downgrade the tenant scheduled.
      const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
      expect(data.cancelAtPeriodEnd).toBe(false);
      expect(data).not.toHaveProperty("downgradeToPlanKey");
      expect(data).not.toHaveProperty("downgradeEffectiveAt");
      expect(data).not.toHaveProperty("retainedUserIds");
    });
  });

  describe("suspendOverdueTenants (→ SUSPENDED)", () => {
    it("emits a NEGATIVE delta via an ACTIVE→SUSPENDED CAS when Stripe confirms past_due", async () => {
      const { svc, tx, events } = make({
        stripeStatus: "unpaid",
        transitionCount: 1,
        addons: [{ priceSnapshot: 12, quantity: 2 }],
      });
      await svc.suspendOverdueTenants();
      expect(tx.tenant.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: "t1", status: "ACTIVE" },
        data: { status: "SUSPENDED" },
      });
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_SUSPENDED)).toBe(-373);
    });

    it("N3: notifies the tenant admin with reason 'overdue payment' only when the suspension actually applied", async () => {
      const { svc, billingNotification } = make({ stripeStatus: "unpaid", transitionCount: 1 });
      await svc.suspendOverdueTenants();
      expect(billingNotification.notifySuspended).toHaveBeenCalledWith("t1", "overdue payment");
    });

    it("N3: does NOT notify when the CAS lost the race (already suspended elsewhere)", async () => {
      const { svc, billingNotification } = make({ stripeStatus: "unpaid", transitionCount: 0 });
      await svc.suspendOverdueTenants();
      expect(billingNotification.notifySuspended).not.toHaveBeenCalled();
    });

    it("N3: a rejected notifySuspended never blocks the cron tick", async () => {
      const { svc, billingNotification } = make({ stripeStatus: "unpaid", transitionCount: 1 });
      billingNotification.notifySuspended.mockRejectedValueOnce(new Error("email down"));
      await expect(svc.suspendOverdueTenants()).resolves.toBeUndefined();
    });

    it("does NOT transition or emit when Stripe reports the sub is still active", async () => {
      const { svc, prisma, events } = make({ stripeStatus: "active" });
      await svc.suspendOverdueTenants();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe("onPaymentSucceeded (SUSPENDED → ACTIVE)", () => {
    it("re-adds a POSITIVE delta via a non-ACTIVE→ACTIVE CAS on reinstatement", async () => {
      const { svc, tx, events } = make({ transitionCount: 1 });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      expect(tx.tenant.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: "t1", status: { not: "ACTIVE" } },
        data: { status: "ACTIVE" },
      });
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toBe(349);
    });

    it("R3 an ACTIVE transition's CAS write also clears a stale readOnlyReason", async () => {
      const { svc, tx } = make({ transitionCount: 1 });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      expect(tx.tenant.updateMany.mock.calls[0][0].data).toEqual({
        status: "ACTIVE",
        readOnlyReason: null,
      });
    });

    it("emits no delta on a renewal / lost race (CAS finds the tenant already ACTIVE)", async () => {
      const { svc, events } = make({ transitionCount: 0 });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
    });

    // STRIPE-CANCEL-1: a tenant who self-serve cancelled (cancelAtPeriodEnd armed) must not be
    // silently resurrected by the next invoice.payment_succeeded — the Stripe subscription was
    // never actually cancelled at period end (that's the defect), so reinstating here would flap
    // the tenant READ_ONLY<->ACTIVE every cycle while Stripe keeps charging. R4.
    it("STRIPE-CANCEL-1 does not reinstate a READ_ONLY tenant with cancelAtPeriodEnd armed — warns and returns, refresh still runs", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const { svc, prisma, tx, events, tenantStatus } = make({
        transitionCount: 1,
        sub: {
          tenantId: "t1",
          planKey: "BUSINESS",
          basePriceSnapshot: 349,
          discount: 0,
          stripeSubId: "sub_1",
          cancelAtPeriodEnd: true,
          // R2: the guard is now narrowed to EXECUTED cancellations (READ_ONLY/CANCELLED) —
          // this is the case the guard must still catch.
          tenant: { status: "READ_ONLY" },
        },
      });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      // The best-effort period-date refresh still runs (it happens before the check).
      expect(prisma.tenantSubscription.update).toHaveBeenCalledWith({
        where: { tenantId: "t1" },
        data: { periodStart: expect.any(Date), periodEnd: expect.any(Date) },
      });
      // No status write, no ledger delta, no disarmedDowngrade (a 2nd tenantSubscription.update),
      // no cache invalidation — nothing else changed.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.tenant.updateMany).not.toHaveBeenCalled();
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
      expect(prisma.tenantSubscription.update).toHaveBeenCalledTimes(1);
      expect(tenantStatus.invalidate).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("STRIPE-CANCEL-1"));
      warn.mockRestore();
    });

    it("STRIPE-CANCEL-1 guard: cancelAtPeriodEnd:false reinstates exactly as before", async () => {
      const { svc, tx, events } = make({
        transitionCount: 1,
        sub: {
          tenantId: "t1",
          planKey: "BUSINESS",
          basePriceSnapshot: 349,
          discount: 0,
          stripeSubId: null,
          cancelAtPeriodEnd: false,
        },
      });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      expect(tx.tenant.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: "t1", status: { not: "ACTIVE" } },
        data: { status: "ACTIVE" },
      });
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toBe(349);
    });

    // (15) R2 (Opus F3) — a SUSPENDED (past-due) tenant who scheduled a cancellation and then
    // PAYS the past-due invoice paid for the period and must be reinstated: nothing else moves
    // them (applyScheduledCancellations only ever looks at ACTIVE tenants). The guard is
    // narrowed to EXECUTED cancellations (READ_ONLY/CANCELLED) only — SUSPENDED falls through
    // to the existing reinstatement exactly as before this fix; cancelAtPeriodEnd stays armed,
    // and cancel() (now Stripe-first) has already told Stripe, which ends the subscription at
    // period end via onSubscriptionDeleted.
    it("REG R2 reinstates a SUSPENDED tenant even though cancelAtPeriodEnd is armed", async () => {
      const { svc, tx, events, tenantStatus } = make({
        transitionCount: 1,
        sub: {
          tenantId: "t1",
          planKey: "BUSINESS",
          basePriceSnapshot: 349,
          discount: 0,
          stripeSubId: "sub_1",
          cancelAtPeriodEnd: true,
          tenant: { status: "SUSPENDED" },
        },
      });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      expect(tx.tenant.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: "t1", status: { not: "ACTIVE" } },
        data: { status: "ACTIVE" },
      });
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toBe(349);
      expect(tenantStatus.invalidate).toHaveBeenCalledWith("t1");
    });

    // (16) R2 — a terminal CANCELLED tenant with cancelAtPeriodEnd armed stays refused, same as
    // READ_ONLY: reinstating a terminal tenant off a late invoice.payment_succeeded is never
    // correct.
    it("REG R2 still refuses reinstatement for a CANCELLED tenant with cancelAtPeriodEnd armed", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const { svc, prisma, tx, events } = make({
        transitionCount: 1,
        sub: {
          tenantId: "t1",
          planKey: "BUSINESS",
          basePriceSnapshot: 349,
          discount: 0,
          stripeSubId: "sub_1",
          cancelAtPeriodEnd: true,
          tenant: { status: "CANCELLED" },
        },
      });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.tenant.updateMany).not.toHaveBeenCalled();
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("STRIPE-CANCEL-1"));
      warn.mockRestore();
    });
  });

  describe("onCheckoutCompleted (non-ACTIVE → ACTIVE)", () => {
    it("re-adds a POSITIVE delta when a non-ACTIVE tenant re-enters via checkout", async () => {
      const { svc, events } = make({ transitionCount: 1 });
      await (svc as any).onCheckoutCompleted({
        metadata: { tenantId: "t1" },
        subscription: "sub_1",
        customer: "cus_1",
      });
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toBe(349);
    });

    it("emits no delta for a fresh checkout with no plans-as-data planKey (even though it activates)", async () => {
      const { svc, events } = make({
        transitionCount: 1,
        sub: { tenantId: "t1", planKey: null, basePriceSnapshot: null, discount: 0 },
      });
      await (svc as any).onCheckoutCompleted({
        metadata: { tenantId: "t1" },
        subscription: "sub_1",
        customer: "cus_1",
      });
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
    });
  });
});

// WP14 / B445: `onCheckoutCompleted`'s upsert wrote NEITHER branch's `planKey` string column
// (the "new source of truth" per schema comment) and the create branch read the wrong metadata
// key (`session.metadata?.plan`, always undefined — checkout stamps `metadata.planKey`), so
// `currentPlan` silently defaulted to STARTER and `planKey` stayed permanently null after every
// real Stripe checkout. That starves `emitPayingDelta` (gated on `planKey != null`) and
// billing-cron's `planKey: { not: null }` MRR filter forever. No new idempotency mechanism is
// added — `transitionAndEmit`'s existing conditional updateMany (the CAS on `count === 1`) is
// still the only thing gating a double emit; these tests prove it already covers the new writes.
describe("onCheckoutCompleted — B445 planKey + basePriceSnapshot write", () => {
  const session = (planKey: string | null | undefined = "GROWTH") => ({
    metadata: { tenantId: "t1", ...(planKey ? { planKey } : {}) },
    subscription: "sub_1",
    customer: "cus_1",
  });

  it("(1) create branch: writes planKey + basePriceSnapshot (and maps currentPlan via planKeyToEnum) and emits exactly one MRR delta", async () => {
    const { svc, prisma, events } = make({ transitionCount: 1 });
    await (svc as any).onCheckoutCompleted(session("GROWTH"));

    const call = prisma.tenantSubscription.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({
      planKey: "GROWTH",
      basePriceSnapshot: 349,
      currentPlan: "TEAM", // planKeyToEnum("GROWTH")
    });
    expect(
      emitted(events).filter((t: string) => t === BILLING_EVENTS.SUBSCRIPTION_RESUMED),
    ).toHaveLength(1);
  });

  it("(2) update branch (the common path — ensureStripeCustomer already pre-created the row): also writes planKey + basePriceSnapshot", async () => {
    const { svc, prisma, events } = make({ transitionCount: 1 });
    await (svc as any).onCheckoutCompleted(session("GROWTH"));

    const call = prisma.tenantSubscription.upsert.mock.calls[0][0];
    expect(call.update).toMatchObject({ planKey: "GROWTH", basePriceSnapshot: 349 });
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toBe(349);
  });

  it("(3) idempotent replay of the same webhook emits the MRR delta only once — the existing CAS covers it, no new mechanism added", async () => {
    const { svc, tx, events } = make({ transitionCount: 1 });
    tx.tenant.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await (svc as any).onCheckoutCompleted(session("GROWTH"));
    await (svc as any).onCheckoutCompleted(session("GROWTH")); // replay — CAS loses, count 0

    expect(
      emitted(events).filter((t: string) => t === BILLING_EVENTS.SUBSCRIPTION_RESUMED),
    ).toHaveLength(1);
  });

  it("(4) negative: metadata carries neither planKey nor the legacy plan key — left completely unchanged on the update branch, no emit", async () => {
    const { svc, prisma, events } = make({
      transitionCount: 1,
      sub: { tenantId: "t1", planKey: null, basePriceSnapshot: null, discount: 0 },
    });
    await (svc as any).onCheckoutCompleted(session(null));

    const call = prisma.tenantSubscription.upsert.mock.calls[0][0];
    expect(call.create.planKey).toBeNull();
    expect(call.update).not.toHaveProperty("planKey");
    expect(call.update).not.toHaveProperty("basePriceSnapshot");
    expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
  });

  it("(5) resolveCatalogPricing throwing does not crash the handler — planKey still gets written, basePriceSnapshot left unset", async () => {
    const pricing = {
      resolveCatalogPricing: jest.fn().mockRejectedValue(new Error("isCustom plan, no price")),
    };
    const { svc, prisma, events } = make({ transitionCount: 1, pricing });

    await expect((svc as any).onCheckoutCompleted(session("GROWTH"))).resolves.toBeUndefined();

    const call = prisma.tenantSubscription.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({ planKey: "GROWTH", basePriceSnapshot: null });
    expect(call.update).toMatchObject({ planKey: "GROWTH" });
    expect(call.update).not.toHaveProperty("basePriceSnapshot");
    // Handler still completes and activates/emits off the upserted row's own planKey.
    expect(emitted(events)).toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
  });

  it("(6) a tenant with a negotiated override completing checkout KEEPS the override — basePriceSnapshot is not touched", async () => {
    const { svc, prisma, events } = make({
      transitionCount: 1,
      sub: {
        tenantId: "t1",
        planKey: "GROWTH",
        basePriceSnapshot: 199, // the negotiated figure already on the row
        discount: 0,
        stripeSubId: null,
        priceOverrideMonthly: 199,
      },
    });
    await (svc as any).onCheckoutCompleted(session("GROWTH"));

    const call = prisma.tenantSubscription.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty("basePriceSnapshot");
    // mrr (the override actually billed) must equal ledgerMrr (what this event says changed) —
    // no divergence: the resumed event's delta reflects the override figure, not the discarded
    // catalog price. (The mock's upsert returns the static `sub` regardless of `data`, so
    // emitPayingDelta reads the delta straight off sub.basePriceSnapshot === 199.)
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toBe(199);
  });

  // ── Lane B A2 / B593: the snapshot/restore hook ────────────────────────────────────────────
  describe("plan-transition hook (B593)", () => {
    it("prepare() runs BEFORE the transaction, onPlanChange(tx) INSIDE it, ahead of the subscription write", async () => {
      const { svc, prisma, tx, planTransition } = make({ transitionCount: 1 });
      const order: string[] = [];
      planTransition.prepare.mockImplementation(async () => {
        order.push("prepare");
        return { enabled: true, planAllows: null };
      });
      const realTx = prisma.$transaction.getMockImplementation();
      prisma.$transaction.mockImplementation(async (fn: any) => {
        order.push("tx-open");
        return realTx!(fn);
      });
      planTransition.onPlanChange.mockImplementation(async () => {
        order.push("onPlanChange");
        return { action: "none" };
      });
      tx.tenantSubscription.upsert.mockImplementation(async (a: unknown) => {
        order.push("upsert");
        return prisma.tenantSubscription.upsert(a);
      });

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      expect(order.slice(0, 4)).toEqual(["prepare", "tx-open", "onPlanChange", "upsert"]);
      const [txArg, transition] = planTransition.onPlanChange.mock.calls[0];
      expect(txArg).toBe(tx);
      expect(transition).toMatchObject({
        tenantId: "t1",
        fromPlanKey: normalizePlanKey("BUSINESS"), // the stored subscription key, normalised
        toPlanKey: "GROWTH",
        toPlanVersionId: "v1",
        actor: { id: null },
      });
    });

    it("a subscription with no stored planKey is judged from the legacy Tenant.plan", async () => {
      const { svc, prisma, planTransition } = make({
        sub: { tenantId: "t1", planKey: null, basePriceSnapshot: null, discount: 0 },
      });
      prisma.tenant.findUnique.mockResolvedValue({ plan: "PROFESSIONAL", planVersionId: null });

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      const [, transition] = planTransition.onPlanChange.mock.calls[0];
      expect(transition.fromPlanKey).toBe(planKeyFromEnum("PROFESSIONAL"));
      expect(transition.toPlanVersionId).toBeNull();
    });

    it("a replay: the stored key equals the checkout's plan, so the hook sees NO rank move (from == to)", async () => {
      const { svc, planTransition } = make({
        sub: { tenantId: "t1", planKey: "GROWTH", basePriceSnapshot: 349, discount: 0 },
      });

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      const [, transition] = planTransition.onPlanChange.mock.calls[0];
      expect(transition.fromPlanKey).toBe(transition.toPlanKey);
    });

    it("a legacy metadata.plan name is normalised to the canonical key before it is stored", async () => {
      const { svc, planTransition } = make();

      await (svc as any).onCheckoutCompleted({
        metadata: { tenantId: "t1", plan: "BUSINESS" },
        subscription: "sub_1",
        customer: "cus_1",
      });

      const [, transition] = planTransition.onPlanChange.mock.calls[0];
      expect(transition.toPlanKey).toBe(normalizePlanKey("BUSINESS"));
    });

    it("MINOR 6 (flag ON): the STORED planKey (create and update) is the canonical key, not the raw legacy metadata string", async () => {
      const { svc, prisma } = make();

      await (svc as any).onCheckoutCompleted({
        metadata: { tenantId: "t1", plan: "BUSINESS" }, // a legacy alias resolves to a canonical key
        subscription: "sub_1",
        customer: "cus_1",
      });

      const canonical = normalizePlanKey("BUSINESS")!;
      const args = prisma.tenantSubscription.upsert.mock.calls[0][0];
      expect(args.update.planKey).toBe(canonical);
      expect(args.create.planKey).toBe(canonical);
    });

    it("flag OFF stays BYTE-IDENTICAL: the legacy metadata.plan string is stored raw (create and update), no canonicalisation", async () => {
      const { svc, prisma, planTransition } = make();
      planTransition.isEnabled.mockResolvedValue(false);

      await (svc as any).onCheckoutCompleted({
        metadata: { tenantId: "t1", plan: "BUSINESS" },
        subscription: "sub_1",
        customer: "cus_1",
      });

      const args = prisma.tenantSubscription.upsert.mock.calls[0][0];
      expect(args.update.planKey).toBe("BUSINESS");
      expect(args.create.planKey).toBe("BUSINESS");
      expect(normalizePlanKey("BUSINESS")).not.toBe("BUSINESS"); // the test would be vacuous otherwise
    });

    it("an unknown plan string is stored as-is (never dropped or nulled)", async () => {
      const { svc, prisma } = make();
      await (svc as any).onCheckoutCompleted(session("GROWTH"));
      expect(prisma.tenantSubscription.upsert.mock.calls[0][0].update.planKey).toBe("GROWTH");
    });

    it("the checkout transaction has an explicit, bounded budget (our own number — Stripe documents no seconds figure)", async () => {
      const { svc, prisma } = make();

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      const opts = prisma.$transaction.mock.calls[0][1];
      expect(opts).toEqual({ timeout: 6_000, maxWait: 2_000 });
      expect(opts.timeout + opts.maxWait).toBeLessThan(10_000); // bounded: a slow restore times out and Stripe retries
    });

    it("flag OFF: no extra tenant read, the hook is never consulted, and the upsert is the PLAIN one (no transaction)", async () => {
      const { svc, prisma, tx, planTransition } = make({ transitionCount: 1 });
      planTransition.isEnabled.mockResolvedValue(false);
      planTransition.prepare.mockResolvedValue({ enabled: false, planAllows: null });

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      expect(planTransition.prepare).not.toHaveBeenCalled();
      expect(planTransition.onPlanChange).not.toHaveBeenCalled();
      // the write is exactly what it always was: called on the client itself, never through a tx
      expect(prisma.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
      expect(tx.tenantSubscription.upsert).not.toHaveBeenCalled();
    });

    it("the flag flipped OFF between the two reads: still the plain upsert (prepared.enabled is false)", async () => {
      const { svc, prisma, tx, planTransition } = make({ transitionCount: 1 });
      planTransition.prepare.mockResolvedValue({ enabled: false, planAllows: null });

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      expect(planTransition.onPlanChange).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
      expect(tx.tenantSubscription.upsert).not.toHaveBeenCalled();
    });

    it("a checkout that names no plan cannot move it: the hook is not consulted at all", async () => {
      const { svc, planTransition } = make({ transitionCount: 1 });

      await (svc as any).onCheckoutCompleted(session(null));

      expect(planTransition.prepare).not.toHaveBeenCalled();
      expect(planTransition.onPlanChange).not.toHaveBeenCalled();
    });

    describe("review of #1038 — stale/duplicate/forged checkouts (flag ON)", () => {
      const withId = (id = "cs_1", extra: Record<string, unknown> = {}) => ({
        ...session("GROWTH"),
        id,
        ...extra,
      });

      it("BLOCKER 1: the plan write is a compare-and-swap on the plan judged from — a concurrent in-app change makes the checkout throw (Stripe redelivers), nothing is written", async () => {
        const { svc, prisma, tx, events } = make({ transitionCount: 1, casCount: 0 });

        await expect((svc as any).onCheckoutCompleted(withId())).rejects.toThrow(/concurrently/);

        expect(tx.tenantSubscription.updateMany.mock.calls[0][0].where).toEqual({
          tenantId: "t1",
          planKey: "BUSINESS", // the stored key the transition was judged from
        });
        expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
        expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
        expect(prisma.auditLog.create).not.toHaveBeenCalled(); // no alarm row for the retryable conflict
      });

      it("the CAS matches a NULL stored planKey as IS NULL, and a fresh tenant (no row) skips it", async () => {
        const nullKey = make({
          sub: { tenantId: "t1", planKey: null, basePriceSnapshot: null, discount: 0 },
        });
        await (nullKey.svc as any).onCheckoutCompleted(withId());
        expect(nullKey.tx.tenantSubscription.updateMany.mock.calls[0][0].where.planKey).toBeNull();

        const fresh = make();
        fresh.prisma.tenantSubscription.findUnique.mockResolvedValue(null);
        await (fresh.svc as any).onCheckoutCompleted(withId());
        expect(fresh.tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
      });

      it("MAJOR 2: a redelivery of an already-applied session does NOTHING (no hook, no write)", async () => {
        const { svc, prisma, tx, planTransition, events } = make({ transitionCount: 1 });
        prisma.auditLog.findFirst.mockResolvedValue({ id: "a1" });

        await (svc as any).onCheckoutCompleted(withId("cs_done"));

        expect(prisma.auditLog.findFirst.mock.calls[0][0].where).toMatchObject({
          tenantId: "t1",
          entityId: "cs_done",
        });
        expect(planTransition.onPlanChange).not.toHaveBeenCalled();
        expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
        expect(emitted(events)).toEqual([]);
        expect(tx.auditLog.create).not.toHaveBeenCalled();
      });

      it("a successful checkout records the session as applied, in the SAME transaction as the write", async () => {
        const { svc, tx } = make({ transitionCount: 1 });
        await (svc as any).onCheckoutCompleted(withId("cs_new"));
        expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
          tenantId: "t1",
          action: "STRIPE_CHECKOUT_APPLIED",
          entityId: "cs_new",
          meta: { toPlanKey: "GROWTH" },
        });
      });

      it("MAJOR 2: a checkout created BEFORE a later downgrade never reverses it — ids/period land, the plan is left alone, an audit row says so", async () => {
        const { svc, prisma, planTransition } = make({ transitionCount: 1 });
        prisma.tenantFeatureConfigSnapshot.findFirst.mockResolvedValue({ id: "snap-newer" });

        await (svc as any).onCheckoutCompleted(withId("cs_old", { created: 1_700_000_000 }));

        expect(prisma.tenantFeatureConfigSnapshot.findFirst.mock.calls[0][0].where).toMatchObject({
          tenantId: "t1",
          reason: "DOWNGRADE",
          takenAt: { gt: new Date(1_700_000_000 * 1000) },
        });
        expect(planTransition.onPlanChange).not.toHaveBeenCalled();
        const update = prisma.tenantSubscription.upsert.mock.calls[0][0].update;
        expect(update).not.toHaveProperty("planKey");
        expect(update).toMatchObject({ stripeSubId: "sub_1" });
        expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
          action: "STRIPE_CHECKOUT_PLAN_SKIPPED_STALE",
          meta: { requestedPlanKey: "GROWTH" },
        });
      });

      it("MAJOR 4: an unknown tenant is REFUSED (nothing written), not warned-and-upserted", async () => {
        const { svc, prisma, planTransition } = make({ transitionCount: 1 });
        prisma.tenant.findUnique.mockResolvedValue(null);

        await (svc as any).onCheckoutCompleted(withId());

        expect(planTransition.onPlanChange).not.toHaveBeenCalled();
        expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        // Stripe gets a 200, so the refusal must leave a trail (tenantId null: the claim is unproven).
        expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
          tenantId: null,
          action: "STRIPE_CHECKOUT_REFUSED",
          entityId: "cs_1",
          meta: { reason: "unknown_tenant" },
        });
      });

      it("a redelivered refusal does not stack a second audit row", async () => {
        const { svc, prisma } = make({ transitionCount: 1 });
        prisma.tenant.findUnique.mockResolvedValue(null);
        prisma.auditLog.findFirst.mockResolvedValue({ id: "a-refused" });

        await (svc as any).onCheckoutCompleted(withId("cs_refused"));

        expect(prisma.auditLog.findFirst.mock.calls[0][0].where).toMatchObject({
          tenantId: null,
          entityId: "cs_refused",
          action: "STRIPE_CHECKOUT_REFUSED",
        });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });

      it("MAJOR 4: a session whose customer is not the tenant's stored Stripe customer is REFUSED", async () => {
        const { svc, prisma, planTransition } = make({
          transitionCount: 1,
          sub: {
            tenantId: "t1",
            planKey: "BUSINESS",
            basePriceSnapshot: 349,
            discount: 0,
            stripeCustomerId: "cus_REAL",
          },
        });

        await (svc as any).onCheckoutCompleted(withId()); // session.customer = cus_1

        expect(planTransition.onPlanChange).not.toHaveBeenCalled();
        expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
        expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
          tenantId: "t1",
          action: "STRIPE_CHECKOUT_REFUSED",
          meta: { reason: "customer_mismatch" },
        });
      });

      it("a stale checkout's CREATE branch keeps a valid enum currentPlan (a plan KEY must never reach the enum column)", async () => {
        const { svc, prisma } = make({ transitionCount: 1 });
        prisma.tenantFeatureConfigSnapshot.findFirst.mockResolvedValue({ id: "snap-newer" });

        await (svc as any).onCheckoutCompleted(withId("cs_stale2", { created: 1_700_000_000 }));

        const create = prisma.tenantSubscription.upsert.mock.calls[0][0].create;
        expect(create.planKey).toBeNull(); // the plan change is skipped ...
        expect(create.currentPlan).toBe("TEAM"); // ... but currentPlan is planKeyToEnum("GROWTH"), not "GROWTH"
      });

      it("MAJOR 3: a hook failure on a PAID checkout leaves an alarm audit row and still fails the handler (Stripe retries)", async () => {
        const { svc, prisma, planTransition } = make({ transitionCount: 1 });
        planTransition.onPlanChange.mockRejectedValueOnce(new Error("snapshot insert failed"));

        await expect((svc as any).onCheckoutCompleted(withId("cs_paid"))).rejects.toThrow(
          "snapshot insert failed",
        );

        expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
          action: "STRIPE_CHECKOUT_HOOK_FAILED",
          entityId: "cs_paid",
        });
      });

      it("MUST-FIX: a concurrent redelivery serialises on a per-session advisory lock and, seeing the winner's committed row INSIDE the tx, does nothing", async () => {
        const { svc, tx, prisma, planTransition, events } = make({ transitionCount: 1 });
        tx.auditLog.findFirst.mockResolvedValue({ id: "won-by-the-other-delivery" });

        await (svc as any).onCheckoutCompleted(withId("cs_race"));

        const lockSql = (tx.$executeRaw as jest.Mock).mock.calls[0][0].join("");
        expect(lockSql).toContain("pg_advisory_xact_lock");
        expect((tx.$executeRaw as jest.Mock).mock.calls[0]).toContain("cs_race");
        expect(planTransition.onPlanChange).not.toHaveBeenCalled();
        expect(tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
        expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
        expect(emitted(events)).toEqual([]);
      });

      it("MUST-FIX: a deadlock/serialization failure is a retryable race — it rethrows WITHOUT the HOOK_FAILED alarm row", async () => {
        const { svc, prisma, planTransition } = make({ transitionCount: 1 });
        planTransition.onPlanChange.mockRejectedValueOnce(
          Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), {
            code: "P2034",
          }),
        );

        await expect((svc as any).onCheckoutCompleted(withId("cs_dl"))).rejects.toThrow(/deadlock/);

        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });

      it("MUST-FIX: the alarm audit row carries the error NAME and code only — never the raw message", async () => {
        const { svc, prisma, planTransition } = make({ transitionCount: 1 });
        planTransition.onPlanChange.mockRejectedValueOnce(
          Object.assign(new Error('insert into "X" values (secret-row-fragment)'), {
            code: "P2002",
          }),
        );

        await expect((svc as any).onCheckoutCompleted(withId("cs_pii"))).rejects.toThrow();

        const meta = prisma.auditLog.create.mock.calls[0][0].data.meta;
        expect(meta).toMatchObject({ toPlanKey: "GROWTH", code: "P2002" });
        expect(JSON.stringify(meta)).not.toContain("secret-row-fragment");
      });

      it("MUST-FIX: a stale checkout (newer downgrade) raises the tenant notification — money taken, plan unchanged — and stores no plan on create", async () => {
        const { svc, prisma, planTransition } = make({ transitionCount: 1 });
        prisma.tenantFeatureConfigSnapshot.findFirst.mockResolvedValue({ id: "snap-newer" });

        await (svc as any).onCheckoutCompleted(withId("cs_stale", { created: 1_700_000_000 }));

        expect(planTransition.onPlanChange).not.toHaveBeenCalled();
        expect((svc as any).billingNotification.notifyCheckoutPlanNotApplied).toHaveBeenCalledWith(
          "t1",
          "GROWTH",
          "cs_stale",
        );
        const create = prisma.tenantSubscription.upsert.mock.calls[0][0].create;
        expect(create.planKey).toBeNull(); // the create branch honours the skipped plan too
      });

      it("MUST-FIX: a legacy session with NO planKey is guarded too (flag on): unknown tenant / foreign customer refused", async () => {
        const noPlan = {
          metadata: { tenantId: "t1" },
          subscription: "sub_1",
          customer: "cus_1",
          id: "cs_np",
        };

        const unknown = make({ transitionCount: 1 });
        unknown.prisma.tenant.findUnique.mockResolvedValue(null);
        await (unknown.svc as any).onCheckoutCompleted(noPlan);
        expect(unknown.prisma.tenantSubscription.upsert).not.toHaveBeenCalled();

        const foreign = make({
          transitionCount: 1,
          sub: { tenantId: "t1", planKey: null, discount: 0, stripeCustomerId: "cus_REAL" },
        });
        await (foreign.svc as any).onCheckoutCompleted(noPlan);
        expect(foreign.prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
      });

      it("prepare() gets the transition it will be judged with (from/to/pin)", async () => {
        const { svc, planTransition } = make({ transitionCount: 1 });
        await (svc as any).onCheckoutCompleted(withId());
        expect(planTransition.prepare.mock.calls[0][0]).toMatchObject({
          tenantId: "t1",
          fromPlanKey: normalizePlanKey("BUSINESS"),
          toPlanKey: "GROWTH",
          toPlanVersionId: "v1",
        });
      });

      it("flag OFF: none of the guards read anything — no audit lookup, no snapshot lookup, no tenant read, plain upsert", async () => {
        const { svc, prisma, tx, planTransition } = make({ transitionCount: 1 });
        planTransition.isEnabled.mockResolvedValue(false);

        await (svc as any).onCheckoutCompleted(withId("cs_off", { created: 1 }));

        expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
        expect(prisma.tenantFeatureConfigSnapshot.findFirst).not.toHaveBeenCalled();
        expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
        expect(tx.tenantSubscription.updateMany).not.toHaveBeenCalled(); // no CAS, no tx write
        expect(tx.auditLog.create).not.toHaveBeenCalled();
        expect(prisma.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
      });
    });

    it("a failing hook (a downgrade whose snapshot cannot be written) aborts the checkout handler (Stripe redelivers): no subscription write, no MRR event", async () => {
      const { svc, prisma, events, planTransition } = make({ transitionCount: 1 });
      planTransition.onPlanChange.mockRejectedValueOnce(new Error("snapshot failed"));

      await expect((svc as any).onCheckoutCompleted(session("GROWTH"))).rejects.toThrow(
        "snapshot failed",
      );

      expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
    });
  });
});

// B216 (owner ruling 2026-09-14): REVERSED from "a reinstatement disarms". Paying an invoice
// settles a debt; it is not a statement about which plan the tenant wants. The old behaviour
// silently revoked a downgrade only the tenant had scheduled, with no event and no audit line,
// leaving them on the plan they had asked to leave. It was justified by the schedule otherwise
// firing "the first night after reactivation" — but firing IS the tenant's stated intent.
describe("B216 — a Stripe reinstatement LEAVES a downgrade scheduled before the lapse armed", () => {
  // A subscription that lapsed with a downgrade armed (scheduled while ACTIVE, then the tenant dropped out).
  const armedSub = (over: Record<string, unknown> = {}) => ({
    tenantId: "t1",
    planKey: "BUSINESS",
    basePriceSnapshot: 349,
    discount: 0,
    stripeSubId: null,
    downgradeToPlanKey: "STARTER",
    downgradeEffectiveAt: new Date("2026-08-01T00:00:00.000Z"),
    retainedUserIds: ["u-keep"],
    ...over,
  });
  // The tenantSubscription.update call that touches the downgrade schedule, if any.
  const disarmCall = (prisma: any) =>
    prisma.tenantSubscription.update.mock.calls.find(
      (c: any[]) => c[0]?.data && "downgradeToPlanKey" in c[0].data,
    );
  // The meta the SUBSCRIPTION_RESUMED ledger event carries: events.emit(tenantId, type, payload,
  // { amountDelta, tx }) — payload is arg 2.
  const resumedMeta = (events: any) =>
    events.emit.mock.calls.find((c: any[]) => c[1] === BILLING_EVENTS.SUBSCRIPTION_RESUMED)?.[2];
  const checkoutSession = {
    metadata: { tenantId: "t1" },
    subscription: "sub_1",
    customer: "cus_1",
  };

  it("REG-B216 onPaymentSucceeded reinstatement (CAS won) leaves the armed downgrade ALONE and names it on the resume event", async () => {
    const { svc, prisma, events } = make({ sub: armedSub(), transitionCount: 1 });
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    // RED before the ruling: this wrote {downgradeToPlanKey: null, ...}.
    expect(disarmCall(prisma)).toBeUndefined();
    expect(resumedMeta(events)).toMatchObject({
      reason: "payment_succeeded",
      downgradeLeftArmed: "STARTER",
      downgradeEffectiveAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("REG-B216 onCheckoutCompleted reinstatement (CAS won) leaves the armed downgrade ALONE and names it on the resume event", async () => {
    const { svc, prisma, events } = make({ sub: armedSub(), transitionCount: 1 });
    await (svc as any).onCheckoutCompleted(checkoutSession);
    expect(disarmCall(prisma)).toBeUndefined();
    expect(resumedMeta(events)).toMatchObject({
      reason: "checkout_completed",
      downgradeLeftArmed: "STARTER",
      downgradeEffectiveAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("REG-B216 a reinstatement with a live Stripe sub writes ONLY the period update — no schedule write at all", async () => {
    const { svc, prisma } = make({ sub: armedSub({ stripeSubId: "sub_1" }), transitionCount: 1 });
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    expect(
      prisma.tenantSubscription.update.mock.calls.map((c: any[]) => Object.keys(c[0].data).sort()),
    ).toEqual([["periodEnd", "periodStart"]]);
  });

  it("REG-B216 a reinstatement with NOTHING armed carries neither schedule key", async () => {
    const { svc, events } = make({
      sub: armedSub({ downgradeToPlanKey: null, downgradeEffectiveAt: null }),
      transitionCount: 1,
    });
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    const meta = resumedMeta(events);
    expect(meta).not.toHaveProperty("downgradeLeftArmed");
    expect(meta).not.toHaveProperty("downgradeEffectiveAt");
  });

  it("REG-B216 the legacy cohort (planKey null → emitPayingDelta short-circuits, no event) still never disarms", async () => {
    // The cohort most likely to be here is exactly the one the ledger cannot record, because
    // emitPayingDelta emits nothing without a planKey — the service logs it instead. What must
    // hold either way is that the tenant's schedule survives.
    const { svc, prisma, events } = make({
      sub: armedSub({ planKey: null, basePriceSnapshot: null }),
      transitionCount: 1,
    });
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
    expect(disarmCall(prisma)).toBeUndefined();
  });

  it("pin B216: an ordinary renewal (CAS count 0) leaves a scheduled downgrade armed", async () => {
    const { svc, prisma } = make({ sub: armedSub({ stripeSubId: "sub_1" }), transitionCount: 0 });
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    expect(disarmCall(prisma)).toBeUndefined();
  });

  it("pin B216: a checkout that loses the CAS (tenant already ACTIVE) leaves a scheduled downgrade armed", async () => {
    const { svc, prisma } = make({ sub: armedSub(), transitionCount: 0 });
    await (svc as any).onCheckoutCompleted(checkoutSession);
    expect(disarmCall(prisma)).toBeUndefined();
  });

  it("pin B216: a reinstatement emits SUBSCRIPTION_RESUMED exactly once (no resume() double emit)", async () => {
    const { svc, events } = make({ sub: armedSub(), transitionCount: 1 });
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    expect(
      emitted(events).filter((t: string) => t === BILLING_EVENTS.SUBSCRIPTION_RESUMED),
    ).toHaveLength(1);
  });

  // The fourth transitionAndEmit site (suspendOverdueTenants) is the ONE that must never disarm:
  // a tenant that goes overdue keeps the downgrade it legitimately scheduled while ACTIVE, so the
  // sweep can still apply it once the tenant is back. Mirroring the three disarming sites here
  // would re-create B216 from the other direction.
  it("pin B216: suspending an overdue tenant leaves a scheduled downgrade armed", async () => {
    const { svc, prisma, tx } = make({
      sub: armedSub({ stripeSubId: "sub_1" }),
      stripeStatus: "unpaid",
      transitionCount: 1,
    });
    await svc.suspendOverdueTenants();
    expect(tx.tenant.updateMany).toHaveBeenCalled(); // the suspension CAS really ran
    expect(disarmCall(prisma)).toBeUndefined();
  });
});

/**
 * BillingService.syncStripeSubscriptionPrice (Platform billing — catalog-driven Stripe
 * prices batch, WP2). Fans a resolved catalog/override price out to a tenant's LIVE
 * Stripe subscription. The owner-decided semantics are `proration_behavior: "none"` —
 * next-billing-cycle only, NEVER an immediate prorated charge/credit — and a tenant with
 * no live Stripe subscription (or one Stripe no longer reports active) is a clean no-op,
 * not an error.
 *
 * Uses Test.createTestingModule (resolving providers by type, not position, so this
 * test doesn't depend on the constructor's exact parameter order).
 */
describe("BillingService.syncStripeSubscriptionPrice", () => {
  let service: BillingService;
  let prisma: { tenantSubscription: { findUnique: jest.Mock; update: jest.Mock } };
  let stripe: { getSubscription: jest.Mock; updateSubscription: jest.Mock; isConfigured: boolean };
  let pricing: { checkoutPriceData: jest.Mock; resolveTenantPricing: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tenantSubscription: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    stripe = {
      getSubscription: jest.fn(),
      updateSubscription: jest.fn().mockResolvedValue({}),
      isConfigured: true,
    };
    pricing = {
      checkoutPriceData: jest.fn(),
      // The sync resolves the price up front (for the MRR ledger reconciliation) and
      // again as price_data for Stripe.
      resolveTenantPricing: jest.fn().mockResolvedValue({
        planKey: "GROWTH",
        planName: "Growth",
        monthly: 150,
        annual: 1500,
        source: "override",
        currency: "usd",
      }),
    };
    events = { emit: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeService, useValue: stripe },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: TenantStatusGuard, useValue: { invalidate: jest.fn() } },
        { provide: BillingEventService, useValue: events },
        { provide: PlatformPricingService, useValue: pricing },
        {
          provide: BillingNotificationService,
          useValue: { notifyCancelled: jest.fn(), notifySuspended: jest.fn() },
        },
        {
          provide: PlanTransitionConfigService,
          useValue: { prepare: jest.fn(), onPlanChange: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
  });

  it("is a no-op ({ synced: false, reason: 'no_active_stripe_subscription' }) when the tenant has no stripeSubId", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      stripeSubId: null,
      billingInterval: null,
    });

    const result = await service.syncStripeSubscriptionPrice("t1");

    expect(result).toEqual({ synced: false, reason: "no_active_stripe_subscription" });
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("is a no-op ({ synced: false }) when Stripe no longer reports the subscription active", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      stripeSubId: "sub_1",
      billingInterval: "month",
    });
    stripe.getSubscription.mockResolvedValue({
      status: "canceled",
      items: {
        data: [{ id: "si_1", price: { recurring: { interval: "month" }, product: "prod_1" } }],
      },
    });

    const result = await service.syncStripeSubscriptionPrice("t1");

    expect(result.synced).toBe(false);
    expect(result.reason).toBe("subscription_not_active_canceled");
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("syncs an active subscription with proration_behavior: 'none' — NEVER an immediate proration/credit", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      stripeSubId: "sub_1",
      billingInterval: "month",
    });
    stripe.getSubscription.mockResolvedValue({
      status: "active",
      items: {
        data: [{ id: "si_1", price: { recurring: { interval: "month" }, product: "prod_1" } }],
      },
    });
    pricing.checkoutPriceData.mockResolvedValue({
      currency: "usd",
      product_data: { name: "RouteFlow Growth — monthly" },
      unit_amount: 15000,
      recurring: { interval: "month" },
    });

    const result = await service.syncStripeSubscriptionPrice("t1");

    expect(result.synced).toBe(true);
    expect(pricing.checkoutPriceData).toHaveBeenCalledWith("t1", "month");
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    const [subId, params] = stripe.updateSubscription.mock.calls[0];
    expect(subId).toBe("sub_1");
    expect(params.proration_behavior).toBe("none");
    expect(params.items).toEqual([
      expect.objectContaining({ id: "si_1", price_data: expect.any(Object) }),
    ]);
    // Owner decision: next-billing-cycle only. "create_prorations" would charge/credit
    // the tenant immediately mid-period — must never be sent.
    expect(params.proration_behavior).not.toBe("create_prorations");
  });

  it("is a no-op ({ synced: false, reason: 'price_unresolvable' }) when no price resolves, instead of throwing", async () => {
    pricing.resolveTenantPricing.mockRejectedValue(new Error("No price is resolvable"));

    const result = await service.syncStripeSubscriptionPrice("t1");

    // Fan-outs call this per tenant; an unpriceable ENTERPRISE tenant must not abort
    // (or 400) the caller — it reports itself as unsynced.
    expect(result).toEqual({ synced: false, reason: "price_unresolvable" });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("moves the MRR ledger with the price: writes basePriceSnapshot and emits a signed amountDelta", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      planKey: "GROWTH",
      basePriceSnapshot: 249,
      stripeSubId: "sub_1",
      billingInterval: "month",
    });
    stripe.getSubscription.mockResolvedValue({
      status: "active",
      items: {
        data: [{ id: "si_1", price: { recurring: { interval: "month" }, product: "prod_1" } }],
      },
    });
    pricing.checkoutPriceData.mockResolvedValue({
      currency: "usd",
      product_data: { name: "RouteFlow Growth — monthly" },
      unit_amount: 15000,
      recurring: { interval: "month" },
    });

    await service.syncStripeSubscriptionPrice("t1");

    // MrrService prices every paying tenant from basePriceSnapshot and reconciles the
    // total against Σ BillingEvent.amountDelta — a price change must move BOTH.
    expect(prisma.tenantSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { basePriceSnapshot: 150 } }),
    );
    const call = events.emit.mock.calls.find((c: any[]) => c[1] === BILLING_EVENTS.PLAN_CHANGED);
    expect(call).toBeDefined();
    expect(call[3]?.amountDelta).toBe(-99); // 150 − 249
  });

  it("does not touch the ledger for a non-paying (planKey null) subscription", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      planKey: null,
      basePriceSnapshot: null,
      stripeSubId: null,
      billingInterval: null,
    });

    await service.syncStripeSubscriptionPrice("t1");

    // MrrService ignores planKey-null tenants entirely; emitting a delta for one would
    // desync the ledger from the snapshot total.
    expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("falls back to the item's own recurring interval over the stored billingInterval when they disagree", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      stripeSubId: "sub_1",
      billingInterval: "year", // stale/stored value — the live Stripe item says otherwise
    });
    stripe.getSubscription.mockResolvedValue({
      status: "active",
      items: {
        data: [{ id: "si_1", price: { recurring: { interval: "month" }, product: "prod_1" } }],
      },
    });
    pricing.checkoutPriceData.mockResolvedValue({
      currency: "usd",
      product_data: { name: "RouteFlow Growth — monthly" },
      unit_amount: 15000,
      recurring: { interval: "month" },
    });

    await service.syncStripeSubscriptionPrice("t1");

    expect(pricing.checkoutPriceData).toHaveBeenCalledWith("t1", "month");
  });
});
