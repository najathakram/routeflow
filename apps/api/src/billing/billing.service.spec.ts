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
import { toCents } from "@routeflow/pricing";
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
import { SubscriptionMutationService } from "./subscription-mutation.service";

/** SA-690: the add-on checkout/adoption seam of SubscriptionMutationService — inert by default (no
 *  add-ons), so every pre-existing assertion in this file measures exactly what it did before. */
const mutationsStub = () =>
  ({
    checkoutAddonLines: jest.fn().mockResolvedValue({ lineItems: [], skus: [] }),
    adoptCheckoutAddons: jest.fn().mockResolvedValue(undefined),
  }) as any;

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
    /** #2440: count of the plain SUSPENDED → CANCELLED compare-and-swap (no ledger delta). */
    plainCasCount?: number;
  } = {},
) {
  const sub = overrides.sub ?? {
    tenantId: "t1",
    planKey: "BUSINESS",
    basePriceSnapshot: 349,
    discount: 0,
    stripeSubId: null,
    // SA-690: a checkout completion writes nothing unless the session's customer is the one stored
    // for the tenant (and the subscription's) — the legitimate case every checkout fixture here is.
    stripeCustomerId: "cus_1",
  };
  const tx = {
    tenant: {
      updateMany: jest.fn().mockResolvedValue({ count: overrides.transitionCount ?? 1 }),
      // SA-140: transitionAndEmit reads deletedAt/class post-CAS for emitPayingDelta's
      // isPayingRow gate — every existing test's tenant is PRODUCTION/non-deleted by default,
      // preserving current behavior exactly.
      findUniqueOrThrow: jest.fn().mockResolvedValue({ deletedAt: null, class: "PRODUCTION" }),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(overrides.addons ?? []),
    },
    // onCheckoutCompleted writes the subscription inside a transaction (A2/B593); it is the SAME
    // mock as prisma.tenantSubscription.upsert so every existing assertion on it still holds.
    tenantSubscription: {
      upsert: jest.fn((args: unknown) => prisma.tenantSubscription.upsert(args)),
      updateMany: jest.fn().mockResolvedValue({ count: overrides.casCount ?? 1 }),
      // X1: the under-the-lock re-check re-reads the stored row — the same mock as the pre-tx read.
      findUnique: jest.fn((args: unknown) => prisma.tenantSubscription.findUnique(args)),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null), // no processed session in the tx by default
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    tenant: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: overrides.plainCasCount ?? 0 }),
      findUnique: jest.fn().mockResolvedValue({ plan: "STARTER", planVersionId: "v1" }),
    },
    // #2440 N2: the tenant's add-on subscription items (none by default).
    tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findFirst: jest.fn().mockResolvedValue({ email: "admin@example.test", username: "admin" }),
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
    // #2440 N3: dahlia-shaped by default — the period lives on the subscription's items.
    getSubscription: jest.fn().mockResolvedValue({
      customer: "cus_1",
      status: overrides.stripeStatus ?? "past_due",
      items: {
        data: [
          { id: "si_base", current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 },
        ],
      },
    }),
    createBillingPortalSession: jest
      .fn()
      .mockResolvedValue({ url: "https://billing.stripe.test/p/session_1" }),
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
    invalidateCaches: jest.fn(),
  } as any;
  const mutations = mutationsStub();
  const svc = new BillingService(
    prisma,
    stripe,
    email,
    tenantStatus,
    events,
    pricing,
    billingNotification,
    planTransition,
    mutations,
  );
  return {
    svc,
    mutations,
    prisma,
    tx,
    stripe,
    email,
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
// #2440 (SA-450): subscription.deleted/updated match on the subscription id AND its customer, so
// these fixtures carry both; a customer-only payload or a free pilot (no stripeSubId) is a no-op.
const LIVE_SUB = {
  tenantId: "t1",
  planKey: "BUSINESS",
  basePriceSnapshot: 349,
  discount: 0,
  stripeSubId: "sub_1",
  stripeCustomerId: "cus_1",
};
const SUB_EVT = { id: "sub_1", customer: "cus_1" };

describe("BillingService — Stripe churn/reactivation MRR ledger", () => {
  describe("onSubscriptionDeleted (→ CANCELLED)", () => {
    it("emits a NEGATIVE churn delta via an ACTIVE→CANCELLED CAS for a paying tenant", async () => {
      const { svc, tx, events } = make({
        transitionCount: 1,
        sub: LIVE_SUB,
        addons: [{ priceSnapshot: 12, quantity: 2 }],
      });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      // Atomic compare-and-swap on status is the idempotency key.
      expect(tx.tenant.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: "t1", status: "ACTIVE" },
        data: { status: "CANCELLED" },
      });
      // −(349 base + 12×2 add-ons − 0 discount) = −373, emitted inside the same tx.
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-373);
    });

    it("SHOULD-2: the contribution sums only BILLABLE add-ons — a comp (a platform grant) carrying a stale snapshot is never counted", async () => {
      const rows = [
        { priceSnapshot: 12, quantity: 2, isComp: false },
        { priceSnapshot: 19, quantity: 1, isComp: true }, // a row that was billed, then turned into a comp
      ];
      const { svc, tx, events } = make({ transitionCount: 1, sub: LIVE_SUB, addons: rows });
      // the query is what excludes the comp: evaluate its `isComp` predicate like Postgres would
      tx.tenantAddon.findMany.mockImplementation(async ({ where }: any) =>
        rows.filter((r) => where?.isComp === undefined || r.isComp === where.isComp),
      );

      await (svc as any).onSubscriptionDeleted(SUB_EVT);

      expect(tx.tenantAddon.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: "t1",
        active: true,
        isComp: false,
      });
      // −(349 base + 12×2 billable add-ons) = −373; the comp's 19 is not part of it
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-373);
    });

    it("is a NO-OP delta when the tenant was already non-ACTIVE and never force-writes a status", async () => {
      const { svc, prisma, events } = make({ transitionCount: 0, sub: LIVE_SUB });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
      // SA-450 (2): the old unconditional tenant.update({status: CANCELLED}) forced TRIAL and
      // READ_ONLY too; only the SUSPENDED → CANCELLED compare-and-swap remains.
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it("emits no delta for a legacy Stripe-only tenant (planKey null) even when the CAS wins", async () => {
      const { svc, events } = make({
        transitionCount: 1,
        sub: { ...LIVE_SUB, planKey: null, basePriceSnapshot: null },
      });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it("disarms a scheduled downgrade alongside cancelAtPeriodEnd (round 3, finding 10)", async () => {
      const { svc, prisma } = make({ transitionCount: 1, sub: LIVE_SUB });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
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
      const { svc, billingNotification } = make({ transitionCount: 1, sub: LIVE_SUB });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      expect(billingNotification.notifyCancelled).toHaveBeenCalledWith("t1");
    });

    it("N3: a rejected notifyCancelled never blocks the cancellation — onSubscriptionDeleted still resolves", async () => {
      const { svc, billingNotification } = make({ transitionCount: 1, sub: LIVE_SUB });
      billingNotification.notifyCancelled.mockRejectedValueOnce(new Error("email down"));
      await expect((svc as any).onSubscriptionDeleted(SUB_EVT)).resolves.toBeUndefined();
    });
  });

  describe("onSubscriptionUpdated (round 3, finding 10)", () => {
    const evt = (cancelAtPeriodEnd: boolean) => ({
      ...SUB_EVT,
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_000_000,
      cancel_at_period_end: cancelAtPeriodEnd,
    });

    it("clears the downgrade markers when the update ARMS a cancellation", async () => {
      const { svc, prisma } = make({ sub: LIVE_SUB });
      await (svc as any).onSubscriptionUpdated(evt(true));
      expect(prisma.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
        cancelAtPeriodEnd: true,
        downgradeToPlanKey: null,
        downgradeEffectiveAt: null,
        retainedUserIds: [],
      });
    });

    it("leaves the downgrade markers untouched on an ordinary update", async () => {
      const { svc, prisma } = make({ sub: LIVE_SUB });
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

    // #2045 (6): emitPayingDelta's paying-set gate reads class/deletedAt post-CAS (SA-140) — a
    // non-PRODUCTION or soft-deleted tenant was never in the paying set, so its suspension books
    // nothing (the status write itself still applies).
    it.each([
      ["a TEST-class tenant", { deletedAt: null, class: "TEST" }],
      ["a soft-deleted tenant", { deletedAt: new Date("2026-09-01"), class: "PRODUCTION" }],
    ])("#2045: %s — the suspension applies but books no delta", async (_label, row) => {
      const { svc, tx, events } = make({
        stripeStatus: "unpaid",
        transitionCount: 1,
        addons: [{ priceSnapshot: 12, quantity: 2 }],
      });
      tx.tenant.findUniqueOrThrow.mockResolvedValue(row);
      await svc.suspendOverdueTenants();
      expect(tx.tenant.updateMany.mock.calls[0][0]).toMatchObject({
        data: { status: "SUSPENDED" },
      });
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_SUSPENDED) ?? 0).toBe(0);
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
      sub: {
        tenantId: "t1",
        planKey: null,
        basePriceSnapshot: null,
        discount: 0,
        stripeCustomerId: "cus_1",
      },
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
        stripeCustomerId: "cus_1",
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
        sub: {
          tenantId: "t1",
          planKey: null,
          basePriceSnapshot: null,
          discount: 0,
          stripeCustomerId: "cus_1",
        },
      });
      prisma.tenant.findUnique.mockResolvedValue({ plan: "PROFESSIONAL", planVersionId: null });

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      const [, transition] = planTransition.onPlanChange.mock.calls[0];
      expect(transition.fromPlanKey).toBe(planKeyFromEnum("PROFESSIONAL"));
      expect(transition.toPlanVersionId).toBeNull();
    });

    it("a replay: the stored key equals the checkout's plan, so the hook sees NO rank move (from == to)", async () => {
      const { svc, planTransition } = make({
        sub: {
          tenantId: "t1",
          planKey: "GROWTH",
          basePriceSnapshot: 349,
          discount: 0,
          stripeCustomerId: "cus_1",
        },
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

    it("flag OFF: no extra tenant read, the hook is never consulted, and the upsert runs in the tenant-locked transaction (X1)", async () => {
      const { svc, prisma, tx, planTransition } = make({ transitionCount: 1 });
      planTransition.isEnabled.mockResolvedValue(false);
      planTransition.prepare.mockResolvedValue({ enabled: false, planAllows: null });

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      expect(planTransition.prepare).not.toHaveBeenCalled();
      expect(planTransition.onPlanChange).not.toHaveBeenCalled();
      // X1: the SAME write, now inside a transaction whose first statement is the tenant row lock, so the
      // duplicate-checkout re-check reads the stored subscription under it; still no hook, no CAS on the plan.
      expect(prisma.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
      expect(tx.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.tenantSubscription.findUnique.mock.invocationCallOrder[0],
      );
      expect(tx.tenantSubscription.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        tx.tenantSubscription.upsert.mock.invocationCallOrder[0],
      );
      expect(tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
    });

    it("the flag flipped OFF between the two reads: still no hook, the upsert in the locked transaction (prepared.enabled is false)", async () => {
      const { svc, prisma, tx, planTransition } = make({ transitionCount: 1 });
      planTransition.prepare.mockResolvedValue({ enabled: false, planAllows: null });

      await (svc as any).onCheckoutCompleted(session("GROWTH"));

      expect(planTransition.onPlanChange).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
      expect(tx.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
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
          stripeSubId: null, // X1: and the subscription id the duplicate question was judged from
        });
        expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
        expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
        expect(prisma.auditLog.create).not.toHaveBeenCalled(); // no alarm row for the retryable conflict
      });

      it("the CAS matches a NULL stored planKey as IS NULL; a tenant with no subscription row is refused before any write (SA-690)", async () => {
        const nullKey = make({
          sub: {
            tenantId: "t1",
            planKey: null,
            basePriceSnapshot: null,
            discount: 0,
            stripeCustomerId: "cus_1",
          },
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
        // only the APPLIED marker exists (the sticky DUPLICATE lookup finds nothing)
        prisma.auditLog.findFirst.mockImplementation(async ({ where }: any) =>
          where.action === "STRIPE_CHECKOUT_APPLIED" ? { id: "a1" } : null,
        );

        await (svc as any).onCheckoutCompleted(withId("cs_done"));

        const applied = prisma.auditLog.findFirst.mock.calls.find(
          (c: any[]) => c[0].where.action === "STRIPE_CHECKOUT_APPLIED",
        );
        expect(applied?.[0].where).toMatchObject({ tenantId: "t1", entityId: "cs_done" });
        expect(planTransition.onPlanChange).not.toHaveBeenCalled();
        expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
        expect(emitted(events)).toEqual([]);
        expect(tx.auditLog.create).not.toHaveBeenCalled();
      });

      it("drops the feature caches AFTER the transaction commits, and not for a redelivery or a failed tx", async () => {
        const ok = make({ transitionCount: 1 });
        const order: string[] = [];
        const realTx = ok.prisma.$transaction.getMockImplementation();
        ok.prisma.$transaction.mockImplementation(async (fn: any, opts: any) => {
          const r = await realTx!(fn, opts);
          order.push("commit");
          return r;
        });
        ok.planTransition.invalidateCaches.mockImplementation(() => order.push("invalidate"));
        await (ok.svc as any).onCheckoutCompleted(withId("cs_inv"));
        // the later status transition opens its own tx; only the order of the first two matters
        expect(order.slice(0, 2)).toEqual(["commit", "invalidate"]);
        expect(ok.planTransition.invalidateCaches).toHaveBeenCalledWith(
          "t1",
          expect.objectContaining({ enabled: true }),
        );

        const dup = make({ transitionCount: 1 });
        dup.prisma.auditLog.findFirst.mockImplementation(async ({ where }: any) =>
          where.action === "STRIPE_CHECKOUT_APPLIED" ? { id: "a1" } : null,
        );
        await (dup.svc as any).onCheckoutCompleted(withId("cs_done"));
        expect(dup.planTransition.invalidateCaches).not.toHaveBeenCalled();

        const failed = make({ transitionCount: 1 });
        failed.planTransition.onPlanChange.mockRejectedValue(new Error("snapshot failed"));
        await expect((failed.svc as any).onCheckoutCompleted(withId("cs_bad"))).rejects.toThrow();
        expect(failed.planTransition.invalidateCaches).not.toHaveBeenCalled();
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
        const { svc, prisma, tx, planTransition } = make({ transitionCount: 1 });
        prisma.tenant.findUnique.mockResolvedValue(null);

        await (svc as any).onCheckoutCompleted(withId());

        expect(planTransition.onPlanChange).not.toHaveBeenCalled();
        expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
        // Stripe gets a 200, so the refusal must leave a trail (tenantId null: the claim is unproven).
        expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
        expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
          tenantId: null,
          action: "STRIPE_CHECKOUT_REFUSED",
          entityId: "cs_1",
          meta: { reason: "unknown_tenant" },
        });
      });

      it("a FIRST refusal takes the session lock, looks up by (entityType, entityId, action) only, and writes exactly one row", async () => {
        const { svc, prisma, tx } = make({ transitionCount: 1 });
        prisma.tenant.findUnique.mockResolvedValue(null);
        const order: string[] = [];
        tx.$executeRaw.mockImplementation(async () => order.push("lock"));
        tx.auditLog.findFirst.mockImplementation(async () => {
          order.push("lookup");
          return null;
        });
        tx.auditLog.create.mockImplementation(async () => order.push("create"));

        await (svc as any).onCheckoutCompleted(withId("cs_first"));

        expect(order).toEqual(["lock", "lookup", "create"]);
        expect(prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 6_000, maxWait: 2_000 });
        // The tenant id is payload, never key (it differs between deliveries), and the key names
        // all three columns — dropping any one silently widens the lookup.
        expect(tx.auditLog.findFirst.mock.calls[0][0].where).toEqual({
          entityType: "stripe_checkout_session",
          entityId: "cs_first",
          action: "STRIPE_CHECKOUT_REFUSED",
        });
      });

      it("a redelivered refusal does not stack a second audit row", async () => {
        const { svc, prisma, tx } = make({ transitionCount: 1 });
        prisma.tenant.findUnique.mockResolvedValue(null);
        tx.auditLog.findFirst.mockResolvedValue({ id: "a-refused" });

        await (svc as any).onCheckoutCompleted(withId("cs_refused"));

        expect(tx.auditLog.findFirst).toHaveBeenCalledTimes(1);
        expect(tx.auditLog.create).not.toHaveBeenCalled();
      });

      it("two CONCURRENT deliveries of one refused session, and one whose tenant resolved differently, leave exactly ONE row", async () => {
        const store: any[] = [];
        let held: Promise<void> | null = null;
        const mk = (tenantFound: boolean) => {
          const m = make({ transitionCount: 1 });
          if (!tenantFound) m.prisma.tenant.findUnique.mockResolvedValue(null);
          else
            m.prisma.tenantSubscription.findUnique.mockResolvedValue({
              tenantId: "t1",
              planKey: "BUSINESS",
              basePriceSnapshot: 349,
              discount: 0,
              stripeCustomerId: "cus_REAL",
            });
          let release: () => void = () => undefined;
          // An advisory xact lock: whoever asks while it is held waits; it is dropped at tx end.
          m.tx.$executeRaw.mockImplementation(async () => {
            while (held) await held;
            held = new Promise<void>((r) => (release = r));
            return 0;
          });
          m.tx.auditLog.findFirst.mockImplementation(async ({ where }: any) => {
            // The READ happens at arrival, the result is delivered later (a real timer): with the
            // lock the other deliveries are still blocked in $executeRaw and read only after the
            // winner committed; without it all three read the empty store before anyone writes.
            // (Delaying the read instead would not race: Node drains microtasks between timers.)
            // Matches on EVERY key it is given, so a tenant-keyed lookup misses across deliveries.
            const found =
              store.find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null;
            await new Promise((r) => setTimeout(r, 15));
            return found;
          });
          m.tx.auditLog.create.mockImplementation(async ({ data }: any) => void store.push(data));
          const realTx = m.prisma.$transaction.getMockImplementation();
          m.prisma.$transaction.mockImplementation(async (fn: any, o: any) => {
            try {
              return await realTx!(fn, o);
            } finally {
              const r = release;
              held = null;
              r();
            }
          });
          return m;
        };
        const a = mk(false);
        const b = mk(false);
        const c = mk(true); // same session, but this delivery finds the tenant (customer mismatch)
        await Promise.all([
          (a.svc as any).onCheckoutCompleted(withId("cs_race")),
          (b.svc as any).onCheckoutCompleted(withId("cs_race")),
          (c.svc as any).onCheckoutCompleted(withId("cs_race")),
        ]);

        expect(store.filter((r) => r.entityId === "cs_race")).toHaveLength(1);
      });

      it("MAJOR 4: a session whose customer is not the tenant's stored Stripe customer is REFUSED", async () => {
        const { svc, prisma, tx, planTransition } = make({
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
        expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
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

      // #2560 / SA-508: a conflict is now retried in-process (retryOnTxConflict); one that PERSISTS
      // past the budget still rethrows (Stripe redelivers) WITHOUT the HOOK_FAILED alarm row.
      it("MUST-FIX: a deadlock/serialization failure is a retryable race — it rethrows WITHOUT the HOOK_FAILED alarm row", async () => {
        const { svc, prisma, planTransition } = make({ transitionCount: 1 });
        planTransition.onPlanChange.mockRejectedValue(
          Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), {
            code: "P2034",
          }),
        );

        await expect((svc as any).onCheckoutCompleted(withId("cs_dl"))).rejects.toThrow(/deadlock/);

        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });

      // #2560 / SA-508: the house lock order inside the snapshot-on checkout tx — the per-session
      // advisory lock, the hook, THEN the Tenant row lock, then the subscription writes + AuditLog.
      it("#2560: advisory lock → hook → Tenant lock → CAS → subscription write → AuditLog", async () => {
        const { svc, tx, planTransition } = make({ transitionCount: 1 });
        const order: string[] = [];
        tx.$executeRaw.mockImplementation(async () => {
          order.push("advisory");
          return 0;
        });
        planTransition.onPlanChange.mockImplementation(async () => {
          order.push("hook");
          return { action: "none" };
        });
        tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
          if (/FROM "Tenant" WHERE id = \? FOR UPDATE/.test(Array.from(strings).join("?")))
            order.push("tenant-lock");
          return [];
        });
        // #2581: the compare-and-set on an existing row is a subscription write too — after the lock.
        tx.tenantSubscription.updateMany.mockImplementation(async () => {
          order.push("cas");
          return { count: 1 };
        });
        const realUpsert = tx.tenantSubscription.upsert.getMockImplementation()!;
        tx.tenantSubscription.upsert.mockImplementation(async (a: any) => {
          order.push("sub-write");
          return realUpsert(a);
        });
        tx.auditLog.create.mockImplementation(async () => {
          order.push("audit");
          return {};
        });

        await (svc as any).onCheckoutCompleted(withId("cs_order"));

        expect(order).toEqual(["advisory", "hook", "tenant-lock", "cas", "sub-write", "audit"]);
      });

      it("#2560: a single 40P01 on the checkout tx is retried and the checkout applies once, no alarm row", async () => {
        const { svc, prisma, planTransition } = make({ transitionCount: 1 });
        planTransition.onPlanChange.mockRejectedValueOnce(
          Object.assign(new Error("deadlock detected"), { code: "40P01" }),
        );

        await (svc as any).onCheckoutCompleted(withId("cs_retry"));

        expect(planTransition.onPlanChange).toHaveBeenCalledTimes(2);
        expect(prisma.tenantSubscription.upsert).toHaveBeenCalledTimes(1);
        expect(
          prisma.auditLog.create.mock.calls.filter(
            (c: any[]) => c[0]?.data?.action === "STRIPE_CHECKOUT_HOOK_FAILED",
          ),
        ).toHaveLength(0);
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

      it("flag OFF: none of the flag-ON guards read anything — no snapshot lookup, no tenant read; the only audit reads are the sticky duplicate decision and the session's APPLIED marker (both read for every flag state, S2)", async () => {
        const { svc, prisma, tx, planTransition } = make({ transitionCount: 1 });
        planTransition.isEnabled.mockResolvedValue(false);

        await (svc as any).onCheckoutCompleted(withId("cs_off", { created: 1 }));

        // X1 + S2: the only audit lookups are the session's sticky DUPLICATE decision and its APPLIED marker (a
        // session that was already applied is never judged a duplicate), read for every flag state
        expect(
          prisma.auditLog.findFirst.mock.calls.every((c: any[]) =>
            ["STRIPE_CHECKOUT_DUPLICATE", "STRIPE_CHECKOUT_APPLIED"].includes(c[0].where.action),
          ),
        ).toBe(true);
        expect(prisma.tenantFeatureConfigSnapshot.findFirst).not.toHaveBeenCalled();
        expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
        expect(tx.tenantSubscription.updateMany).not.toHaveBeenCalled(); // no CAS, no tx write
        // B1157: the plain apply tx writes the APPLIED marker (and nothing else) — every apply path does
        expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
        expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
          action: "STRIPE_CHECKOUT_APPLIED",
          entityId: "cs_off",
        });
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
    stripeCustomerId: "cus_1",
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
  let prisma: {
    tenantSubscription: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    tenantAddon: { findMany: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let stripe: { getSubscription: jest.Mock; updateSubscription: jest.Mock; isConfigured: boolean };
  let pricing: { checkoutPriceData: jest.Mock; resolveTenantPricing: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tenantSubscription: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        // #2509: reconcilePriceLedger's compare-and-set write (1 = the row still held what it read).
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
      // SA-485b (ii): the reconcile's Tenant row lock.
      $queryRaw: jest.fn().mockResolvedValue([]),
      // #2440: the tenant's add-on subscription items (none by default).
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
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
        { provide: SubscriptionMutationService, useValue: mutationsStub() },
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

  // SA-733 D8 / M7: the push takes an explicit proration mode, carries a deterministic idempotency key, never
  // skips a live past_due / unpaid subscription, and hands back what it needs to be undone.
  describe("SA-733 D8/M7 — effective mode, idempotency key, live statuses", () => {
    const liveSub = (status: string, priceId = "price_old") => ({
      status,
      items: {
        data: [
          {
            id: "si_1",
            price: {
              id: priceId,
              unit_amount: 10000,
              recurring: { interval: "month" },
              product: "prod_1",
            },
          },
        ],
      },
    });
    const arrange = (status = "active") => {
      prisma.tenantSubscription.findUnique.mockResolvedValue({
        tenantId: "t1",
        stripeSubId: "sub_1",
        billingInterval: "month",
        planKey: "GROWTH",
        basePriceSnapshot: 150,
        tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
      });
      stripe.getSubscription.mockResolvedValue(liveSub(status));
      pricing.checkoutPriceData.mockResolvedValue({
        currency: "usd",
        product_data: { name: "RouteFlow Growth — monthly" },
        unit_amount: 15000,
        recurring: { interval: "month" },
      });
    };

    it("now_prorated sends create_prorations; next_cycle and the default send none", async () => {
      arrange();
      await service.syncStripeSubscriptionPrice("t1", { effective: "now_prorated" });
      await service.syncStripeSubscriptionPrice("t1", { effective: "next_cycle" });
      await service.syncStripeSubscriptionPrice("t1");
      const modes = stripe.updateSubscription.mock.calls.map((c) => c[1].proration_behavior);
      expect(modes).toEqual(["create_prorations", "none", "none"]);
    });

    it("a proposed override prices the push (checkoutPriceData gets it); no proposal leaves the call as before", async () => {
      arrange();
      const proposed = { monthly: 150, annual: null };
      await service.syncStripeSubscriptionPrice("t1", { proposed });
      expect(pricing.checkoutPriceData).toHaveBeenLastCalledWith("t1", "month", proposed);
      await service.syncStripeSubscriptionPrice("t1");
      expect(pricing.checkoutPriceData).toHaveBeenLastCalledWith("t1", "month");
    });

    it("every Stripe update carries an idempotency key: tenant, price-override, cents, effective, row version, item price", async () => {
      arrange();
      const version = new Date("2026-10-01T12:00:00.000Z");
      await service.syncStripeSubscriptionPrice("t1", { effective: "now_prorated", version });
      const [, , options] = stripe.updateSubscription.mock.calls[0];
      expect(options).toEqual({
        idempotencyKey: `t1:price-override:15000:now_prorated:v${version.getTime()}:price_old`,
      });
    });

    it("the key differs for a different amount, mode or row version — a later change is never swallowed", async () => {
      arrange();
      const keys: string[] = [];
      const run = async (opts: any, cents = 15000) => {
        pricing.checkoutPriceData.mockResolvedValue({
          currency: "usd",
          product_data: { name: "x" },
          unit_amount: cents,
          recurring: { interval: "month" },
        });
        await service.syncStripeSubscriptionPrice("t1", opts);
        keys.push(stripe.updateSubscription.mock.calls.at(-1)![2].idempotencyKey);
      };
      await run({ version: new Date(1000) });
      await run({ version: new Date(1000) }); // an identical retry repeats the key
      await run({ version: new Date(2000) });
      await run({ version: new Date(1000), effective: "now_prorated" });
      await run({ version: new Date(1000) }, 16000);
      expect(keys[0]).toBe(keys[1]);
      expect(new Set(keys).size).toBe(4);
    });

    it("the amount sent is whole cents from the shared helper (19.99 dollars -> 1999)", async () => {
      arrange();
      pricing.checkoutPriceData.mockResolvedValue({
        currency: "usd",
        product_data: { name: "x" },
        unit_amount: toCents(19.99),
        recurring: { interval: "month" },
      });
      await service.syncStripeSubscriptionPrice("t1");
      const item = stripe.updateSubscription.mock.calls[0][1].items[0];
      expect(item.price_data.unit_amount).toBe(1999);
    });

    it.each(["past_due", "unpaid"])(
      "M7: a %s subscription is repriced, and takes the change at the NEXT invoice even for now_prorated",
      async (status) => {
        arrange(status);
        const result = await service.syncStripeSubscriptionPrice("t1", {
          effective: "now_prorated",
        });
        expect(result.synced).toBe(true);
        expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
        expect(stripe.updateSubscription.mock.calls[0][1].proration_behavior).toBe("none");
        expect(result.proration).toBe("none");
      },
    );

    it("M7: a trialing subscription is repriced and still honours now_prorated", async () => {
      arrange("trialing");
      const result = await service.syncStripeSubscriptionPrice("t1", { effective: "now_prorated" });
      expect(result.synced).toBe(true);
      expect(stripe.updateSubscription.mock.calls[0][1].proration_behavior).toBe(
        "create_prorations",
      );
    });

    it.each(["canceled", "incomplete", "incomplete_expired", "paused"])(
      "M7 pin: a %s subscription is not live — nothing is sent to Stripe",
      async (status) => {
        arrange(status);
        const result = await service.syncStripeSubscriptionPrice("t1");
        expect(result).toEqual({ synced: false, reason: `subscription_not_active_${status}` });
        expect(stripe.updateSubscription).not.toHaveBeenCalled();
      },
    );

    it("M7 pin: a manual-pay tenant (no stripeSubId) never reaches Stripe", async () => {
      prisma.tenantSubscription.findUnique.mockResolvedValue({
        tenantId: "t1",
        stripeSubId: null,
        billingInterval: "month",
      });
      const result = await service.syncStripeSubscriptionPrice("t1", { effective: "now_prorated" });
      expect(result).toEqual({ synced: false, reason: "no_active_stripe_subscription" });
      expect(stripe.getSubscription).not.toHaveBeenCalled();
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("a Stripe update failure is reported as stripe_update_failed (the caller refuses the local write)", async () => {
      arrange();
      stripe.updateSubscription.mockRejectedValue(new Error("stripe down"));
      const result = await service.pushResolvedPriceToStripe("t1");
      expect(result).toEqual({ synced: false, reason: "stripe_update_failed" });
    });

    it("hands back an undo; revertPricePush restores the previous cents with the same proration under a :revert key", async () => {
      arrange();
      const pushed = await service.pushResolvedPriceToStripe("t1", { effective: "now_prorated" });
      expect(pushed.undo).toMatchObject({
        subscriptionId: "sub_1",
        itemId: "si_1",
        productId: "prod_1",
        previousCents: 10000,
        proration: "create_prorations",
      });
      stripe.updateSubscription.mockClear();
      expect(await service.revertPricePush("t1", pushed.undo!)).toBe(true);
      const [subId, params, options] = stripe.updateSubscription.mock.calls[0];
      expect(subId).toBe("sub_1");
      expect(params.proration_behavior).toBe("create_prorations");
      expect(params.items[0]).toEqual({
        id: "si_1",
        price_data: {
          currency: "usd",
          unit_amount: 10000,
          recurring: { interval: "month" },
          product: "prod_1",
        },
      });
      expect(options.idempotencyKey).toBe(`${pushed.undo!.key}:revert`);
    });

    it("revertPricePush reports false (and does not throw) when the revert itself fails", async () => {
      arrange();
      const pushed = await service.pushResolvedPriceToStripe("t1");
      stripe.updateSubscription.mockRejectedValue(new Error("stripe down"));
      expect(await service.revertPricePush("t1", pushed.undo!)).toBe(false);
    });

    it("{ pushed } skips the Stripe half: only the ledger reconciles", async () => {
      arrange();
      prisma.tenantSubscription.findUnique.mockResolvedValue({
        tenantId: "t1",
        planKey: "GROWTH",
        basePriceSnapshot: 100, // resolved monthly is 150 -> the ledger half moves it
        tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
      });
      await service.syncStripeSubscriptionPrice("t1", {
        pushed: { synced: true, oldAmount: 100, newAmount: 150 },
      });
      expect(stripe.getSubscription).not.toHaveBeenCalled();
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.updateMany).toHaveBeenCalled();
    });
  });

  // #2509: reconcilePriceLedger is ONE transaction — read, compare-and-set on the (planKey, snapshot) it
  // read, emit in the same tx. A miss re-reads: a plan changed meanwhile ⇒ this resolved price is stale
  // for the row, skip (the plan path wrote its own snapshot); only the snapshot moved ⇒ retry against it.
  describe("#2509 reconcilePriceLedger — compare-and-set in one transaction", () => {
    const row = (planKey: string, snapshot: number) => ({
      tenantId: "t1",
      planKey,
      basePriceSnapshot: snapshot,
      stripeSubId: null, // the Stripe push is a no-op; only the reconcile is under test
      billingInterval: "month",
      tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
    });
    /** The sync's own read returns `first`; each reconcile read (it selects the tenant) takes the next. */
    const reads = (first: any, reconcileReads: any[]) =>
      prisma.tenantSubscription.findUnique.mockImplementation(async (args: any) =>
        args?.select?.tenant ? (reconcileReads.shift() ?? reconcileReads[0]) : first,
      );
    const planChanged = () =>
      events.emit.mock.calls.filter((c: any[]) => c[1] === BILLING_EVENTS.PLAN_CHANGED);

    it("writes by compare-and-set on the planKey + snapshot it read, and emits in the same tx", async () => {
      reads(row("GROWTH", 249), [row("GROWTH", 249)]);
      await service.syncStripeSubscriptionPrice("t1");
      expect(prisma.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", planKey: "GROWTH", basePriceSnapshot: 249 },
        data: { basePriceSnapshot: 150 },
      });
      expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
      const [c] = planChanged();
      expect(c?.[3]).toMatchObject({ amountDelta: -99, tx: expect.anything() });
    });

    // SA-485b (ii): the reconcile takes the SAME Tenant FOR UPDATE that updatePlan and
    // updateTenantPriceOverride take — lock → read → CAS → emit in one tx — so it serializes with them.
    it("SA-485b: takes the Tenant row lock FIRST, before its read and its compare-and-set", async () => {
      reads(row("GROWTH", 249), [row("GROWTH", 249)]);
      await service.syncStripeSubscriptionPrice("t1");
      const lockIdx = prisma.$queryRaw.mock.calls.findIndex((c: any[]) =>
        String(c[0]?.join?.("?") ?? c[0]).includes('"Tenant"'),
      );
      expect(lockIdx).toBeGreaterThan(-1);
      const lockAt = prisma.$queryRaw.mock.invocationCallOrder[lockIdx];
      const reconcileRead = prisma.tenantSubscription.findUnique.mock.calls.findIndex(
        (c: any[]) => c[0]?.select?.tenant,
      );
      expect(lockAt).toBeLessThan(
        prisma.tenantSubscription.findUnique.mock.invocationCallOrder[reconcileRead],
      );
      expect(lockAt).toBeLessThan(prisma.tenantSubscription.updateMany.mock.invocationCallOrder[0]);
    });

    it("a plan change committed meanwhile (CAS miss, planKey moved) ⇒ nothing written or booked", async () => {
      reads(row("GROWTH", 249), [row("GROWTH", 249), row("SCALE", 499)]);
      prisma.tenantSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.syncStripeSubscriptionPrice("t1");
      expect(prisma.tenantSubscription.updateMany).toHaveBeenCalledTimes(1);
      expect(planChanged()).toHaveLength(0);
    });

    it("only the snapshot moved (CAS miss, same plan) ⇒ retried against the fresh value, booked once", async () => {
      reads(row("GROWTH", 249), [row("GROWTH", 249), row("GROWTH", 200)]);
      prisma.tenantSubscription.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      await service.syncStripeSubscriptionPrice("t1");
      expect(prisma.tenantSubscription.updateMany.mock.calls[1][0]).toEqual({
        where: { tenantId: "t1", planKey: "GROWTH", basePriceSnapshot: 200 },
        data: { basePriceSnapshot: 150 },
      });
      expect(planChanged()).toHaveLength(1);
      expect(planChanged()[0][3].amountDelta).toBe(-50); // 150 − 200, never 150 − 249
    });

    // SA-503a (#2528 fold): the reconcile runs AFTER the fee and the Stripe push committed, so a lock
    // conflict here must be retried — never a 500 that leaves the snapshot stale behind them.
    it("SA-503a: a 40P01 on the reconcile's transaction is retried and books exactly once", async () => {
      reads(row("GROWTH", 249), [row("GROWTH", 249)]);
      prisma.$transaction.mockImplementationOnce(async () => {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      });
      await service.syncStripeSubscriptionPrice("t1");
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(planChanged()).toHaveLength(1);
      expect(planChanged()[0][3].amountDelta).toBe(-99);
    });
  });

  it("moves the MRR ledger with the price: writes basePriceSnapshot and emits a signed amountDelta", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      planKey: "GROWTH",
      basePriceSnapshot: 249,
      stripeSubId: "sub_1",
      billingInterval: "month",
      // SA-140: reconcilePriceLedger's own internal findUnique (same mock — this fixture backs
      // both) now selects the tenant relation for its isPayingRow gate.
      tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
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
    // #2509: the snapshot moves by compare-and-set (reconcilePriceLedger's one transaction).
    expect(prisma.tenantSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { basePriceSnapshot: 150 } }),
    );
    const call = events.emit.mock.calls.find((c: any[]) => c[1] === BILLING_EVENTS.PLAN_CHANGED);
    expect(call).toBeDefined();
    expect(call[3]?.amountDelta).toBe(-99); // 150 − 249
  });

  it("SA-140 item 1: a suspended PRODUCTION tenant's price still moves the snapshot but books NO ledger event (gate the emit, not the snapshot)", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      planKey: "SCALE",
      basePriceSnapshot: 499,
      stripeSubId: "sub_1",
      billingInterval: "month",
      tenant: { status: "SUSPENDED", deletedAt: null, class: "PRODUCTION" },
    });
    pricing.resolveTenantPricing.mockResolvedValue({
      planKey: "SCALE",
      planName: "Scale",
      monthly: 599,
      annual: 5990,
      source: "override",
      currency: "usd",
    });
    stripe.getSubscription.mockResolvedValue({
      status: "active",
      items: {
        data: [{ id: "si_1", price: { recurring: { interval: "month" }, product: "prod_1" } }],
      },
    });
    pricing.checkoutPriceData.mockResolvedValue({
      currency: "usd",
      product_data: { name: "RouteFlow Scale — monthly" },
      unit_amount: 59900,
      recurring: { interval: "month" },
    });

    await service.syncStripeSubscriptionPrice("t1");

    // The snapshot always stays current — so a later reactivation books the CORRECT (new)
    // price, not a stale one.
    // #2509: the snapshot moves by compare-and-set (reconcilePriceLedger's one transaction).
    expect(prisma.tenantSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { basePriceSnapshot: 599 } }),
    );
    // But no ledger event — `mrr` never counted this tenant while suspended, and a delta here
    // would drift `ledgerMrr` above `mrr` (the exact bug this item fixes).
    expect(
      events.emit.mock.calls.find((c: any[]) => c[1] === BILLING_EVENTS.PLAN_CHANGED),
    ).toBeUndefined();
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
  // #2440 (lead ruling A, a money bug): Stripe does not order items base-first. An add-on item
  // listed first must never be repriced to the plan price — only the base-plan item is.
  // SA-461: when EVERY item is a known add-on there is no base-plan item to reprice — the period
  // read may fall back to the first item, but the price sync must refuse rather than overwrite an
  // add-on with the plan price.
  it("#2440 SA-461: every item a known add-on ⇒ { synced: false, reason: 'no_base_item' }", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      stripeSubId: "sub_1",
      billingInterval: "month",
    });
    prisma.tenantAddon.findMany.mockResolvedValue([{ stripeItemId: "si_addon" }]);
    stripe.getSubscription.mockResolvedValue({
      status: "active",
      items: {
        data: [
          { id: "si_addon", price: { recurring: { interval: "month" }, product: "prod_addon" } },
        ],
      },
    });
    pricing.checkoutPriceData.mockResolvedValue({
      currency: "usd",
      product_data: { name: "RouteFlow Growth — monthly" },
      unit_amount: 15000,
      recurring: { interval: "month" },
    });

    const result = await service.syncStripeSubscriptionPrice("t1");

    expect(result).toEqual({ synced: false, reason: "no_base_item" });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("#2440: reprices the base-plan item, never an add-on item listed first", async () => {
    prisma.tenantSubscription.findUnique.mockResolvedValue({
      tenantId: "t1",
      stripeSubId: "sub_1",
      billingInterval: "month",
    });
    prisma.tenantAddon.findMany.mockResolvedValue([{ stripeItemId: "si_addon" }]);
    stripe.getSubscription.mockResolvedValue({
      status: "active",
      items: {
        data: [
          { id: "si_addon", price: { recurring: { interval: "month" }, product: "prod_addon" } },
          { id: "si_base", price: { recurring: { interval: "month" }, product: "prod_base" } },
        ],
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
    const [, params] = stripe.updateSubscription.mock.calls[0];
    expect(params.items).toHaveLength(1);
    expect(params.items[0].id).toBe("si_base");
    expect(params.items[0].price_data.product).toBe("prod_base");
  });
});

// #2436 (P0): SDK 22.6.2 pins Stripe API 2026-08-26.dahlia, where current_period_start/end live on
// the subscription's ITEMS (SubscriptionItems.d.ts:54-58), not on the subscription. Reading the old
// top-level field gave `new Date(NaN)` — Prisma rejected it, checkout.session.completed 500'd and
// stripeSubId was never stored. These fixtures are dahlia-shaped; the old mocks kept tests green.
describe("#2436 Stripe API dahlia — the subscription period lives on items", () => {
  const START = new Date(1_700_000_000 * 1000);
  const END = new Date(1_702_000_000 * 1000);
  const dahlia = (extra: Record<string, unknown> = {}) => ({
    status: "active",
    customer: "cus_1",
    items: { data: [{ current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 }] },
    ...extra,
  });

  it("checkout.session.completed stores stripeSubId and the period read from items", async () => {
    const { svc, prisma, stripe } = make({ transitionCount: 1 });
    stripe.getSubscription.mockResolvedValue(dahlia());
    await (svc as any).onCheckoutCompleted({
      metadata: { tenantId: "t1" },
      subscription: "sub_1",
      customer: "cus_1",
    });
    const args = prisma.tenantSubscription.upsert.mock.calls[0][0];
    expect(args.update.stripeSubId).toBe("sub_1");
    expect(args.create.periodStart).toEqual(START);
    expect(args.create.periodEnd).toEqual(END);
    expect(args.update.periodStart).toEqual(START);
    expect(args.update.periodEnd).toEqual(END);
  });

  it("customer.subscription.updated reads a dahlia payload's period from items", async () => {
    const { svc, prisma } = make({ sub: LIVE_SUB });
    await (svc as any).onSubscriptionUpdated({
      ...SUB_EVT,
      cancel_at_period_end: false,
      ...dahlia(),
    });
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodStart).toEqual(START);
    expect(data.periodEnd).toEqual(END);
  });

  it("invoice.payment_succeeded refreshes the period from the retrieved subscription's items", async () => {
    const { svc, prisma, stripe } = make({
      sub: {
        tenantId: "t1",
        planKey: "BUSINESS",
        basePriceSnapshot: 349,
        discount: 0,
        stripeSubId: "sub_1",
        tenant: { status: "ACTIVE" },
      },
    });
    stripe.getSubscription.mockResolvedValue(dahlia());
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    const periodWrite = prisma.tenantSubscription.update.mock.calls.find(
      (c: any[]) => c[0].data?.periodStart !== undefined,
    );
    expect(periodWrite?.[0].data).toMatchObject({ periodStart: START, periodEnd: END });
  });

  it("a subscription with no period anywhere writes NO period fields (never an Invalid Date)", async () => {
    const { svc, prisma } = make({ sub: LIVE_SUB });
    await (svc as any).onSubscriptionUpdated({ ...SUB_EVT, cancel_at_period_end: false });
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("periodStart");
    expect(data).not.toHaveProperty("periodEnd");
  });

  it("a pre-dahlia payload (top-level period, older endpoint version) still reads its period", async () => {
    const { svc, prisma } = make({ sub: LIVE_SUB });
    await (svc as any).onSubscriptionUpdated({
      ...SUB_EVT,
      cancel_at_period_end: false,
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_000_000,
    });
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodStart).toEqual(START);
    expect(data.periodEnd).toEqual(END);
  });
});

// #2440 (SA-450, tier 1): subscription upkeep. deleted/updated match on the subscription id AND its
// customer (never a customer-wide write); a webhook never forces TRIAL/READ_ONLY to CANCELLED; the −MRR
// churn delta is booked once per lifecycle (SUSPENDED already removed the run-rate); updated maps only
// `canceled`; payment_failed counts and links the billing portal; free pilots (no stripeSubId) are
// untouched by every branch. Real-Postgres pins are F2's NEED-DB.
describe("#2440 subscription upkeep — match by subscription id, status mapping, dunning", () => {
  const writesNothing = (prisma: any, tx: any, events: any) => {
    expect(tx.tenant.updateMany).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  };

  describe("customer.subscription.deleted", () => {
    it("looks the row up by the subscription id, not the customer", async () => {
      const { svc, prisma } = make({ transitionCount: 1, sub: LIVE_SUB });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      expect(prisma.tenantSubscription.findFirst.mock.calls[0][0].where).toEqual({
        stripeSubId: "sub_1",
      });
    });

    it("another customer's subscription id ⇒ log + no-op (no status, row, ledger or email)", async () => {
      const { svc, prisma, tx, events, billingNotification } = make({
        transitionCount: 1,
        sub: { ...LIVE_SUB, stripeCustomerId: "cus_other" },
      });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      writesNothing(prisma, tx, events);
      expect(billingNotification.notifyCancelled).not.toHaveBeenCalled();
    });

    it("no matching row ⇒ no-op", async () => {
      const { svc, prisma, tx, events } = make({ transitionCount: 1 });
      prisma.tenantSubscription.findFirst.mockResolvedValue(null);
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      writesNothing(prisma, tx, events);
    });

    it("a payload without a subscription id ⇒ no lookup, no-op", async () => {
      const { svc, prisma, tx, events } = make({ transitionCount: 1, sub: LIVE_SUB });
      await (svc as any).onSubscriptionDeleted({ customer: "cus_1" });
      expect(prisma.tenantSubscription.findFirst).not.toHaveBeenCalled();
      writesNothing(prisma, tx, events);
    });

    it("a free pilot (no stripeSubId on the row) is untouched", async () => {
      const { svc, prisma, tx, events } = make({
        transitionCount: 1,
        sub: { ...LIVE_SUB, stripeSubId: null },
      });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      writesNothing(prisma, tx, events);
    });

    it("SUSPENDED ⇒ CANCELLED by a plain compare-and-swap, with NO second −MRR delta", async () => {
      const { svc, prisma, events, billingNotification } = make({
        transitionCount: 0, // not ACTIVE
        plainCasCount: 1,
        sub: LIVE_SUB,
      });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      expect(prisma.tenant.updateMany.mock.calls[0][0]).toEqual({
        where: { id: "t1", status: "SUSPENDED" },
        data: { status: "CANCELLED" },
      });
      // Suspension (cron or platform admin) already booked the −MRR; cancelling books nothing.
      expect(events.emit).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
        cancelAtPeriodEnd: true,
      });
      expect(billingNotification.notifyCancelled).toHaveBeenCalledWith("t1");
    });

    it("TRIAL / READ_ONLY are never forced to CANCELLED (both compare-and-swaps lose)", async () => {
      const { svc, prisma, events, billingNotification } = make({
        transitionCount: 0,
        plainCasCount: 0,
        sub: LIVE_SUB,
      });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(billingNotification.notifyCancelled).not.toHaveBeenCalled();
    });

    it("a duplicate webhook after ACTIVE ⇒ CANCELLED books the churn delta exactly once", async () => {
      const { svc, tx, events } = make({ transitionCount: 1, sub: LIVE_SUB });
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      tx.tenant.updateMany.mockResolvedValue({ count: 0 }); // now CANCELLED: the CAS loses
      await (svc as any).onSubscriptionDeleted(SUB_EVT);
      expect(
        emitted(events).filter((t: string) => t === BILLING_EVENTS.SUBSCRIPTION_CANCELED),
      ).toHaveLength(1);
    });
  });

  describe("customer.subscription.updated", () => {
    const upd = (status: string, extra: Record<string, unknown> = {}) => ({
      ...SUB_EVT,
      status,
      cancel_at_period_end: false,
      ...extra,
    });

    it("looks the row up by the subscription id", async () => {
      const { svc, prisma } = make({ sub: LIVE_SUB });
      await (svc as any).onSubscriptionUpdated(upd("active"));
      expect(prisma.tenantSubscription.findFirst.mock.calls[0][0].where).toEqual({
        stripeSubId: "sub_1",
      });
    });

    it("status canceled behaves as deleted: ACTIVE ⇒ CANCELLED with one −MRR delta", async () => {
      const { svc, tx, events } = make({ transitionCount: 1, sub: LIVE_SUB });
      await (svc as any).onSubscriptionUpdated(upd("canceled"));
      expect(tx.tenant.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: "t1", status: "ACTIVE" },
        data: { status: "CANCELLED" },
      });
      expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-349);
    });

    it.each(["past_due", "unpaid", "trialing", "active", "incomplete"])(
      "status %s writes NO tenant status (grace stays with the cron, reinstatement with payment)",
      async (status) => {
        const { svc, prisma, tx, events } = make({
          transitionCount: 1,
          plainCasCount: 1,
          sub: LIVE_SUB,
        });
        await (svc as any).onSubscriptionUpdated(upd(status));
        expect(tx.tenant.updateMany).not.toHaveBeenCalled();
        expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
      },
    );

    it("another customer's subscription id ⇒ no write at all", async () => {
      const { svc, prisma, tx, events } = make({
        transitionCount: 1,
        sub: { ...LIVE_SUB, stripeCustomerId: "cus_other" },
      });
      await (svc as any).onSubscriptionUpdated(upd("canceled"));
      writesNothing(prisma, tx, events);
    });

    it("a free pilot (no stripeSubId on the row) is untouched", async () => {
      const { svc, prisma, tx, events } = make({ sub: { ...LIVE_SUB, stripeSubId: null } });
      await (svc as any).onSubscriptionUpdated(upd("canceled", { cancel_at_period_end: true }));
      writesNothing(prisma, tx, events);
    });
  });

  describe("invoice.payment_failed", () => {
    const FAILING = {
      ...LIVE_SUB,
      failedPaymentCount: 0,
      tenant: { id: "t1", slug: "acme", name: "Acme" },
    };
    // Under dahlia the invoice's subscription lives at parent.subscription_details.subscription.
    const failed = (extra: Record<string, unknown> = {}) => ({
      customer: "cus_1",
      parent: { subscription_details: { subscription: "sub_1" } },
      ...extra,
    });

    it("matches by the invoice's subscription id and increments failedPaymentCount", async () => {
      const { svc, prisma } = make({ sub: FAILING });
      await (svc as any).onPaymentFailed(failed());
      expect(prisma.tenantSubscription.findFirst.mock.calls[0][0].where).toEqual({
        stripeSubId: "sub_1",
      });
      expect(prisma.tenantSubscription.update.mock.calls[0][0]).toEqual({
        where: { tenantId: "t1" },
        data: { failedPaymentCount: { increment: 1 } },
      });
    });

    it("reads a pre-dahlia invoice's top-level subscription too", async () => {
      const { svc, prisma } = make({ sub: FAILING });
      await (svc as any).onPaymentFailed({ customer: "cus_1", subscription: { id: "sub_1" } });
      expect(prisma.tenantSubscription.update).toHaveBeenCalledTimes(1);
    });

    it("the warning email carries the billing-portal link", async () => {
      const { svc, stripe, email } = make({ sub: FAILING });
      await (svc as any).onPaymentFailed(failed());
      // The second argument (#2476's request cap) is pinned by its own test below.
      expect(stripe.createBillingPortalSession.mock.calls[0][0]).toEqual(
        expect.objectContaining({ customerId: "cus_1" }),
      );
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(email.send.mock.calls[0][0].html).toContain("https://billing.stripe.test/p/session_1");
    });

    // #2476 Opus MED fold: stripe-node's defaults (80 s timeout, network retries) could hold the
    // webhook claim for minutes; the email's portal link is best-effort, so its call is capped.
    it("#2476: the payment-failed portal call is capped (10 s, no network retries)", async () => {
      const { svc, stripe } = make({ sub: FAILING });
      await (svc as any).onPaymentFailed(failed());
      expect(stripe.createBillingPortalSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cus_1" }),
        { timeoutMs: 10_000, maxNetworkRetries: 0 },
      );
    });

    it("#2476: the user-facing portal session keeps Stripe's default request options", async () => {
      const { svc, stripe } = make({ sub: FAILING });
      await svc.createBillingPortalSession("t1");
      expect(stripe.createBillingPortalSession).toHaveBeenCalledTimes(1);
      expect(stripe.createBillingPortalSession.mock.calls[0][1]).toBeUndefined();
    });

    it("a portal failure still sends the email, with today's fallback text", async () => {
      const { svc, stripe, email } = make({ sub: FAILING });
      stripe.createBillingPortalSession.mockRejectedValue(new Error("portal down"));
      await (svc as any).onPaymentFailed(failed());
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(email.send.mock.calls[0][0].html).toContain("contacting support");
    });

    it("changes no tenant status", async () => {
      const { svc, prisma, tx, events } = make({ sub: FAILING });
      await (svc as any).onPaymentFailed(failed());
      expect(tx.tenant.updateMany).not.toHaveBeenCalled();
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it("another customer's subscription id ⇒ no count, no email", async () => {
      const { svc, prisma, email } = make({ sub: { ...FAILING, stripeCustomerId: "cus_other" } });
      await (svc as any).onPaymentFailed(failed());
      expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
    });

    // #2476 / SA-472: the increment is the event's effect; everything after it (admin lookup, portal,
    // email) is non-throwing and logged — a later throw must never mark the event "error:" and make a
    // redelivery re-run the increment.
    it("#2476: an admin lookup that throws AFTER the increment never fails the handler (count once)", async () => {
      const { svc, prisma, email } = make({ sub: FAILING });
      prisma.user.findFirst.mockRejectedValue(new Error("db blip"));
      const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation(() => undefined);
      await expect((svc as any).onPaymentFailed(failed())).resolves.toBeUndefined();
      expect(prisma.tenantSubscription.update).toHaveBeenCalledTimes(1);
      expect(email.send).not.toHaveBeenCalled();
      expect(warn.mock.calls.some((c: any[]) => /payment-failed email/i.test(String(c[0])))).toBe(
        true,
      );
    });

    it("an invoice with no subscription (free pilot / one-off) is untouched", async () => {
      const { svc, prisma, email } = make({ sub: { ...FAILING, stripeSubId: null } });
      await (svc as any).onPaymentFailed({ customer: "cus_1" });
      expect(prisma.tenantSubscription.findFirst).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
    });
  });

  describe("invoice.payment_succeeded resets the failure count", () => {
    const paying = (failedPaymentCount: number) => ({
      ...LIVE_SUB,
      failedPaymentCount,
      tenant: { status: "ACTIVE" },
    });

    it("resets failedPaymentCount to 0 after a failure", async () => {
      const { svc, prisma } = make({ transitionCount: 0, sub: paying(2) });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      const reset = prisma.tenantSubscription.update.mock.calls.find(
        (c: any[]) => c[0].data?.failedPaymentCount !== undefined,
      );
      expect(reset?.[0]).toEqual({ where: { tenantId: "t1" }, data: { failedPaymentCount: 0 } });
    });

    it("writes no reset when the count is already 0", async () => {
      const { svc, prisma } = make({ transitionCount: 0, sub: paying(0) });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      const reset = prisma.tenantSubscription.update.mock.calls.find(
        (c: any[]) => c[0].data?.failedPaymentCount !== undefined,
      );
      expect(reset).toBeUndefined();
    });
  });
});

// #2440: Opus nits on #2446, folded here. N1: a null period is logged in every handler (a null
// periodEnd hides the tenant from the overdue cron). N2: the period comes from the base-plan item,
// never a known add-on item (TenantAddon.stripeItemId).
describe("#2440 Opus nits on #2446 — period source and null-period warnings", () => {
  const twoItems = {
    items: {
      data: [
        { id: "si_addon", current_period_start: 1_600_000_000, current_period_end: 1_600_100_000 },
        { id: "si_base", current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 },
      ],
    },
  };
  const BASE_END = new Date(1_702_000_000 * 1000);

  it("N2: subscription.updated reads the base item's period, skipping the tenant's add-on item", async () => {
    const { svc, prisma } = make({ sub: LIVE_SUB });
    prisma.tenantAddon.findMany.mockResolvedValue([{ stripeItemId: "si_addon" }]);
    await (svc as any).onSubscriptionUpdated({
      ...SUB_EVT,
      cancel_at_period_end: false,
      ...twoItems,
    });
    expect(prisma.tenantSubscription.update.mock.calls[0][0].data.periodEnd).toEqual(BASE_END);
  });

  it("N2: payment_succeeded reads the base item's period, skipping the tenant's add-on item", async () => {
    const { svc, prisma, stripe } = make({
      transitionCount: 0,
      sub: { ...LIVE_SUB, failedPaymentCount: 0, tenant: { status: "ACTIVE" } },
    });
    prisma.tenantAddon.findMany.mockResolvedValue([{ stripeItemId: "si_addon" }]);
    stripe.getSubscription.mockResolvedValue(twoItems);
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    const periodWrite = prisma.tenantSubscription.update.mock.calls.find(
      (c: any[]) => c[0].data?.periodEnd !== undefined,
    );
    expect(periodWrite?.[0].data.periodEnd).toEqual(BASE_END);
  });

  it("N1: subscription.updated with no period logs a warning", async () => {
    const { svc } = make({ sub: LIVE_SUB });
    const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation(() => undefined);
    await (svc as any).onSubscriptionUpdated({ ...SUB_EVT, cancel_at_period_end: false });
    expect(warn.mock.calls.some((c: any[]) => /no billing period/.test(String(c[0])))).toBe(true);
  });

  it("N1: payment_succeeded with no period on the retrieved subscription logs a warning", async () => {
    const { svc, stripe } = make({
      transitionCount: 0,
      sub: { ...LIVE_SUB, failedPaymentCount: 0, tenant: { status: "ACTIVE" } },
    });
    stripe.getSubscription.mockResolvedValue({ status: "active" });
    const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation(() => undefined);
    await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
    expect(warn.mock.calls.some((c: any[]) => /no billing period/.test(String(c[0])))).toBe(true);
  });

  it("N1: checkout.session.completed with no period logs a warning and still stores stripeSubId", async () => {
    const { svc, prisma, stripe } = make({ transitionCount: 1 });
    stripe.getSubscription.mockResolvedValue({ status: "active", customer: "cus_1" });
    const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation(() => undefined);
    await (svc as any).onCheckoutCompleted({
      metadata: { tenantId: "t1" },
      subscription: "sub_1",
      customer: "cus_1",
    });
    expect(prisma.tenantSubscription.upsert.mock.calls[0][0].update.stripeSubId).toBe("sub_1");
    expect(warn.mock.calls.some((c: any[]) => /no billing period/.test(String(c[0])))).toBe(true);
  });
});
