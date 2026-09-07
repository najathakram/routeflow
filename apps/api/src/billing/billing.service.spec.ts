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
import { BillingService } from "./billing.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "./stripe.service";
import { EmailService } from "../email/email.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { BillingEventService } from "./billing-event.service";
import { PlatformPricingService } from "./platform-pricing.service";

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
  };
  const prisma = {
    tenant: {
      update: jest.fn().mockResolvedValue({}),
    },
    tenantSubscription: {
      findFirst: jest.fn().mockResolvedValue(sub),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { ...sub, stripeSubId: "sub_1", tenant: { id: sub.tenantId, slug: "acme" } },
        ]),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue(sub),
    },
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
  const svc = new BillingService(prisma, stripe, email, tenantStatus, events);
  return { svc, prisma, tx, stripe, events, tenantStatus };
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

    it("emits no delta on a renewal / lost race (CAS finds the tenant already ACTIVE)", async () => {
      const { svc, events } = make({ transitionCount: 0 });
      await (svc as any).onPaymentSucceeded({ customer: "cus_1" });
      expect(emitted(events)).not.toContain(BILLING_EVENTS.SUBSCRIPTION_RESUMED);
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
