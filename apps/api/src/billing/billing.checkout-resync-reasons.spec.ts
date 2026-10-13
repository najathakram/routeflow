/**
 * Go-live M3: what the post-checkout price re-sync does with each push result. A PERMANENT reason (nothing
 * a redelivery can change) raises ONE ops alert and is ACKNOWLEDGED; a TRANSIENT one THROWS so Stripe redelivers.
 * The coupon sync runs whatever the price push did. Stripe and the database are mocks.
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

function make() {
  const prisma: any = {
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const svc: any = new BillingService(
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
  const sync = jest.spyOn(svc, "syncStripeSubscriptionPrice");
  const coupon = jest.spyOn(svc, "syncCoupon").mockResolvedValue({} as any);
  return { svc, prisma, sync, coupon };
}

const session = { id: "cs_1" };
const alerts = (prisma: any) =>
  prisma.auditLog.create.mock.calls
    .map((c: any[]) => c[0].data)
    .filter((d: any) => d.action === "STRIPE_PRICE_PUSH_BLOCKED");

beforeEach(() => {
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("resyncPriceAfterCheckout — permanent reasons alert and acknowledge (M3)", () => {
  it.each(["no_base_item", "no_subscription_item"])(
    "%s: one ops alert, then ACKNOWLEDGED (no throw, so no redelivery storm)",
    async (reason) => {
      const { svc, prisma, coupon } = make();
      svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: false, reason });
      await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).resolves.toBeUndefined();
      const rows = alerts(prisma);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: "t1", entityType: "tenant" });
      expect(rows[0].meta).toMatchObject({
        platformAdmin: true,
        reason,
        checkoutSessionId: "cs_1",
      });
      expect(coupon).toHaveBeenCalledWith("t1", "sub_1", "checkout_completed");
    },
  );

  it.each(["subscription_not_active_paused", "subscription_not_active_incomplete"])(
    "%s: alerted (the price did not reach Stripe) and acknowledged",
    async (reason) => {
      const { svc, prisma, coupon } = make();
      svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: false, reason });
      await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).resolves.toBeUndefined();
      expect(alerts(prisma)).toHaveLength(1);
      expect(alerts(prisma)[0].meta).toMatchObject({ reason });
      expect(coupon).toHaveBeenCalledTimes(1);
    },
  );

  it("an alert that cannot be written is NOT acknowledged: it throws so the redelivery raises it", async () => {
    const { svc, prisma } = make();
    svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: false, reason: "no_base_item" });
    prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
      if (data.action === "STRIPE_PRICE_PUSH_BLOCKED") throw new Error("db down");
      return {};
    });
    await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).rejects.toThrow("db down");
  });

  it("a settled or unchanged push raises no alert", async () => {
    const { svc, prisma } = make();
    svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: true, unchanged: true });
    await svc.resyncPriceAfterCheckout("t1", session, "sub_1");
    expect(alerts(prisma)).toHaveLength(0);
  });
});

describe("resyncPriceAfterCheckout — every other non-synced reason alerts and acknowledges", () => {
  it.each(["price_unresolvable", "no_active_stripe_subscription", "some_reason_added_later"])(
    "%s (not a known transient): one alert, acknowledged, coupon still synced",
    async (reason) => {
      const { svc, prisma, coupon } = make();
      svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: false, reason });
      await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).resolves.toBeUndefined();
      expect(alerts(prisma)).toHaveLength(1);
      expect(alerts(prisma)[0].meta).toMatchObject({ reason });
      expect(coupon).toHaveBeenCalledTimes(1);
    },
  );

  it("a non-synced result with NO reason is alerted too", async () => {
    const { svc, prisma } = make();
    svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: false });
    await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).resolves.toBeUndefined();
    expect(alerts(prisma)).toHaveLength(1);
  });

  it("a redelivery does not write a second alert for the same session and reason", async () => {
    const { svc, prisma } = make();
    svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: false, reason: "no_base_item" });
    prisma.auditLog.findFirst.mockResolvedValue({ id: "already" });
    await svc.resyncPriceAfterCheckout("t1", session, "sub_1");
    expect(alerts(prisma)).toHaveLength(0);
    expect(prisma.auditLog.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: "t1",
      action: "STRIPE_PRICE_PUSH_BLOCKED",
    });
  });
});

describe("resyncPriceAfterCheckout — transient reasons throw (M3)", () => {
  it.each([
    "stripe_retrieve_failed",
    "stripe_product_create_failed",
    "stripe_update_failed",
    "reconcile_flag_failed",
    "stripe_not_configured",
  ])("%s: THROWS so Stripe redelivers, and raises no alert", async (reason) => {
    const { svc, prisma, coupon } = make();
    svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: false, reason });
    await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).rejects.toThrow(/re-sync/);
    expect(alerts(prisma)).toHaveLength(0);
    expect(coupon).toHaveBeenCalledTimes(1); // still synced
  });
});

describe("syncCoupon runs REGARDLESS of the price-push outcome (M3)", () => {
  it("a push that THROWS still syncs the coupon, and the push error is what surfaces", async () => {
    const { svc, coupon } = make();
    svc.syncStripeSubscriptionPrice.mockRejectedValue(new Error("stripe down"));
    await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).rejects.toThrow(
      "stripe down",
    );
    expect(coupon).toHaveBeenCalledWith("t1", "sub_1", "checkout_completed");
  });

  it("a coupon sync that fails after a good push THROWS (the redelivery retries it)", async () => {
    const { svc, coupon } = make();
    svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: true, unchanged: true });
    coupon.mockRejectedValue(new Error("coupon read failed"));
    await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).rejects.toThrow(
      "coupon read failed",
    );
  });

  it("both failing: the push error surfaces (the coupon error is logged, not masked over it)", async () => {
    const { svc, coupon } = make();
    svc.syncStripeSubscriptionPrice.mockResolvedValue({
      synced: false,
      reason: "stripe_update_failed",
    });
    coupon.mockRejectedValue(new Error("coupon read failed"));
    await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).rejects.toThrow(/re-sync/);
  });

  it("a permanent push reason with a failing coupon sync still throws (coupon is retried)", async () => {
    const { svc, coupon } = make();
    svc.syncStripeSubscriptionPrice.mockResolvedValue({ synced: false, reason: "no_base_item" });
    coupon.mockRejectedValue(new Error("coupon read failed"));
    await expect(svc.resyncPriceAfterCheckout("t1", session, "sub_1")).rejects.toThrow(
      "coupon read failed",
    );
  });
});
