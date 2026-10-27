/**
 * W-810 / SA-931: a Checkout-born subscription's base item points at an INACTIVE inline product. A price push
 * must still land (the push brings its own active, deterministic product), and a Stripe 4xx refusal is the new
 * PERMANENT reason `stripe_update_rejected` (a redelivery cannot change it), while 409 / 429 / 5xx stay transient.
 * Stripe is the stateful fake (it refuses an inactive product); the database is a mock.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
}));

import { Logger } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { PlatformPricingService } from "./platform-pricing.service";
import { isPermanentPricePushReason, isPricePushFailure } from "./price-override";
import { fakeStripeSubscription } from "../testing/fake-stripe-subscription";
import { stripeError } from "../testing/fake-stripe-products";

function make(opts: { override?: number } = {}) {
  const fake = fakeStripeSubscription(
    [
      {
        id: "si_1",
        quantity: 1,
        price: {
          id: "price_0",
          unit_amount: 34_900,
          currency: "usd",
          product: "prod_checkout_inline",
          recurring: { interval: "month" },
        },
      },
    ],
    "active",
    [{ id: "prod_checkout_inline", active: false, name: "RouteFlow Starter" }],
  );
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({
        id: "t1",
        plan: "STARTER",
        planVersionId: null,
        subscription: {
          planKey: "STARTER",
          priceOverrideMonthly: opts.override ?? 150,
          priceOverrideAnnual: null,
        },
      })),
    },
    tenantSubscription: {
      findUnique: jest.fn(async () => ({
        stripeSubId: "sub_1",
        billingInterval: "month",
        planKey: "STARTER",
        basePriceSnapshot: 349,
        couponFull: false,
        tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const planCatalog: any = {
    getVersionForTenant: jest.fn(async () => ({
      definitions: [{ planKey: "STARTER", name: "Starter", monthlyPrice: 349, annualPrice: 3490 }],
    })),
  };
  const svc: any = new BillingService(
    prisma,
    fake as any,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn() } as any,
    new PlatformPricingService(prisma, planCatalog, fake as any),
    {} as any,
    {} as any,
    {} as any,
  );
  return { svc, fake, prisma };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("price push on a Checkout-born subscription", () => {
  it("lands on an active deterministic plan product, never the inactive inline one", async () => {
    const { svc, fake } = make();
    const r = await svc.syncStripeSubscriptionPrice("t1");
    expect(r).toMatchObject({ synced: true, newAmount: 150 });
    expect(fake.amountOf("si_1")).toBe(15_000);
    expect(fake.state.items[0].price.product).toBe("rf_plan_starter");
    expect(fake.products.table.get("rf_plan_starter")?.active).toBe(true);
  });

  it("a second push reuses the same product (no product per push)", async () => {
    const { svc, fake } = make();
    await svc.syncStripeSubscriptionPrice("t1");
    const before = fake.products.table.size;
    fake.state.items[0].price.unit_amount = 34_900; // reset so the second push has work to do
    await svc.syncStripeSubscriptionPrice("t1");
    expect(fake.products.table.size).toBe(before);
  });
});

describe("stripe_update_rejected (permanent) vs transient update failures", () => {
  it("is a push failure AND permanent: a redelivery cannot change a Stripe 4xx", () => {
    expect(isPricePushFailure({ synced: false, reason: "stripe_update_rejected" })).toBe(true);
    expect(isPermanentPricePushReason("stripe_update_rejected")).toBe(true);
    expect(isPermanentPricePushReason("stripe_update_failed")).toBe(false);
  });

  it.each([
    [400, "stripe_update_rejected"],
    [402, "stripe_update_rejected"],
    [404, "stripe_update_rejected"],
    [409, "stripe_update_failed"],
    [429, "stripe_update_failed"],
    [500, "stripe_update_failed"],
  ])("Stripe %i on the update -> %s", async (status, reason) => {
    const { svc, fake } = make();
    fake.updateSubscription.mockRejectedValueOnce(stripeError(status, "x", "refused"));
    const r = await svc.syncStripeSubscriptionPrice("t1");
    expect(r).toMatchObject({ synced: false, reason });
  });

  it("a rejection carries Stripe's message for the operator", async () => {
    const { svc, fake } = make();
    fake.updateSubscription.mockRejectedValueOnce(stripeError(400, "x", "price is invalid"));
    const r = await svc.syncStripeSubscriptionPrice("t1");
    expect(r).toMatchObject({
      synced: false,
      reason: "stripe_update_rejected",
      detail: "price is invalid",
    });
  });
});
