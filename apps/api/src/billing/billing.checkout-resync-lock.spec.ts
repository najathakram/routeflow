/**
 * Go-live M1: the post-checkout price re-sync pushes a tenant's Stripe price, so it takes the same
 * per-tenant price lock as every other price writer, and reads the price state AFTER acquiring it.
 * Stripe and the lock are mocks; nothing here can reach a real account or database.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: (...a: unknown[]) => mockWithAdvisoryLock(...a),
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
}));

import { ConflictException, Logger } from "@nestjs/common";
import { assertLivePaymentsAllowed } from "./live-payments-wall";
import { BillingService } from "./billing.service";
import { PlatformPricingService } from "./platform-pricing.service";
import { fakeStripeProducts } from "../testing/fake-stripe-products";

const { LockTimeoutError } = jest.requireMock("../common/db-locks");

function make() {
  const prisma: any = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
  const svc = new BillingService(
    prisma,
    { isConfigured: true } as any,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { svc: svc as any, prisma };
}

const session = { id: "cs_1" };

beforeEach(() => {
  mockWithAdvisoryLock.mockReset();
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("resyncPriceAfterCheckout holds the tenant price lock (M1)", () => {
  it("takes the tenant-price family keyed on the tenant, with the short tenant-facing wait", async () => {
    const { svc } = make();
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    }));
    jest
      .spyOn(svc, "syncStripeSubscriptionPrice")
      .mockResolvedValue({ synced: true, unchanged: true });
    await svc.resyncPriceAfterCheckout("t1", session);
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(mockWithAdvisoryLock.mock.calls[0][0]).toMatchObject({
      family: "tenant-price",
      key: "t1",
      mode: "wait",
      waitMs: 2_500,
    });
  });

  it("race (REAL resolver): an admin override committed before the webhook gets the lock is the price pushed", async () => {
    // Only I/O is faked: a stateful in-memory database and Stripe. syncStripeSubscriptionPrice, the pricing
    // resolver (PlatformPricingService.resolveTenantPricing) and the Stripe push all run for real.
    const db = { override: null as number | null, snapshot: 349, ledger: [] as number[] };
    const stripeState = { cents: 34_900, updates: [] as number[] };
    const log: string[] = [];
    const prisma: any = {
      tenant: {
        findUnique: jest.fn(async () => ({
          id: "t1",
          plan: "STARTER",
          planVersionId: null,
          subscription: {
            planKey: "STARTER",
            priceOverrideMonthly: db.override,
            priceOverrideAnnual: null,
          },
        })),
      },
      tenantSubscription: {
        findUnique: jest.fn(async () => ({
          stripeSubId: "sub_1",
          billingInterval: "month",
          planKey: "STARTER",
          basePriceSnapshot: db.snapshot,
          couponFull: false,
          tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" },
        })),
        updateMany: jest.fn(async (a: any) => {
          if (a.data.basePriceSnapshot !== undefined) db.snapshot = a.data.basePriceSnapshot;
          return { count: 1 };
        }),
      },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const planCatalog: any = {
      getVersionForTenant: jest.fn(async () => ({
        definitions: [
          { planKey: "STARTER", name: "Starter", monthlyPrice: 349, annualPrice: 3490 },
        ],
      })),
    };
    const stripe: any = {
      isConfigured: true,
      client: { products: fakeStripeProducts().products },
      getSubscription: jest.fn(async () => ({
        id: "sub_1",
        status: "active",
        items: {
          data: [
            {
              id: "si_1",
              price: {
                id: "price_1",
                unit_amount: stripeState.cents,
                product: "prod_1",
                recurring: { interval: "month" },
              },
            },
          ],
        },
      })),
      updateSubscription: jest.fn(async (_id: string, params: any) => {
        stripeState.cents = params.items[0].price_data.unit_amount;
        stripeState.updates.push(stripeState.cents);
        log.push("stripe-push");
      }),
    };
    const events: any = {
      emit: jest.fn(async (_t: string, _e: string, _m: unknown, o: any) => {
        db.ledger.push(o.amountDelta);
      }),
    };
    const svc: any = new BillingService(
      prisma,
      stripe,
      { send: jest.fn() } as any,
      { invalidate: jest.fn() } as any,
      events,
      new PlatformPricingService(prisma, planCatalog, stripe),
      {} as any,
      {} as any,
      {} as any,
    );
    // The admin writer holds the lock first: it pushed 150 to Stripe and committed the override. The webhook
    // only gets the lock once that writer is done, so anything it resolved BEFORE the lock is stale.
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => {
      db.override = 150;
      db.snapshot = 150;
      stripeState.cents = 15_000;
      log.push("lock-acquired");
      return { acquired: true, value: await fn() };
    });

    await svc.resyncPriceAfterCheckout("t1", session);

    expect(log[0]).toBe("lock-acquired");
    expect(stripeState.cents).toBe(15_000); // still the admin's price
    expect(stripeState.updates).toEqual([]); // nothing re-pushed: the item already bills the override
    expect(db.snapshot).toBe(150);
    expect(db.ledger).toEqual([]); // and no stale ledger delta booked from the catalog price
  });

  it("nothing is read or pushed before the lock is held", async () => {
    const { svc } = make();
    mockWithAdvisoryLock.mockRejectedValue(new LockTimeoutError());
    const sync = jest.spyOn(svc, "syncStripeSubscriptionPrice");
    await expect(svc.resyncPriceAfterCheckout("t1", session)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sync).not.toHaveBeenCalled();
  });

  it("a lock collision THROWS (a coded retryable 409), so Stripe redelivers the webhook", async () => {
    const { svc } = make();
    mockWithAdvisoryLock.mockRejectedValue(new LockTimeoutError());
    const err: any = await svc.resyncPriceAfterCheckout("t1", session).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "CONCURRENT_UPDATE" });
  });
});

// W-1464 R-305 M1: a wall refusal must never reach Stripe as a 500 (a multi-day retry storm for an event that can
// never succeed). Handler level: held row, handler resolves. Dispatcher level: the same for any handler.
describe("live-payments wall in the checkout and webhook paths (R-305 M1)", () => {
  function refusal(): unknown {
    try {
      assertLivePaymentsAllowed("TEST");
    } catch (e) {
      return e;
    }
    throw new Error("the wall did not refuse");
  }
  const heldRows = (prisma: any) =>
    prisma.auditLog.create.mock.calls
      .map((c: any[]) => c[0].data)
      .filter((d: any) => d.action === "LIVE_PAYMENTS_HELD");

  it("a refused price re-sync after checkout is held and acknowledged, and the coupon sync still runs", async () => {
    const { svc, prisma } = make();
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    }));
    jest.spyOn(svc, "syncStripeSubscriptionPrice").mockRejectedValue(refusal());
    const coupon = jest.spyOn(svc, "syncCoupon").mockResolvedValue(undefined);
    await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).resolves.toBeUndefined();
    expect(heldRows(prisma)).toHaveLength(1);
    expect(heldRows(prisma)[0]).toMatchObject({ tenantId: "t1", entityId: "cs_1" });
    expect(coupon).toHaveBeenCalledTimes(1);
  });

  it("a non-refusal error from the re-sync still throws (redelivery stays)", async () => {
    const { svc, prisma } = make();
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    }));
    jest.spyOn(svc, "syncStripeSubscriptionPrice").mockRejectedValue(new Error("stripe down"));
    await expect(svc.resyncPriceAfterCheckout("t1", session)).rejects.toThrow("stripe down");
    expect(heldRows(prisma)).toHaveLength(0);
  });

  it.each([
    ["checkout.session.completed", "onCheckoutCompleted"],
    ["invoice.upcoming", "onInvoiceUpcoming"],
    ["invoice.payment_succeeded", "onPaymentSucceeded"],
  ])(
    "a refusal escaping the %s handler is held and acknowledged at the dispatcher",
    async (type, handler) => {
      const { svc, prisma } = make();
      jest.spyOn(svc, handler).mockRejectedValue(refusal());
      await expect(
        svc.handleWebhookEvent({ id: "evt_1", type, data: { object: {} } }),
      ).resolves.toBeUndefined();
      expect(heldRows(prisma)).toHaveLength(1);
      expect(heldRows(prisma)[0]).toMatchObject({ tenantId: null, entityId: "evt_1" });
    },
  );

  it("any other error from a handler still propagates through the dispatcher", async () => {
    const { svc, prisma } = make();
    jest.spyOn(svc, "onCheckoutCompleted").mockRejectedValue(new Error("db down"));
    await expect(
      svc.handleWebhookEvent({
        id: "evt_1",
        type: "checkout.session.completed",
        data: { object: {} },
      }),
    ).rejects.toThrow("db down");
    expect(heldRows(prisma)).toHaveLength(0);
  });
});
