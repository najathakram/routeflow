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
import { BillingService } from "./billing.service";

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

  it("race: an admin override pushed under the lock is NOT overwritten by the webhook's old price", async () => {
    const { svc } = make();
    const stripe = { price: 349 }; // what Stripe bills
    const db = { override: null as number | null }; // the committed override
    const log: string[] = [];
    // The admin writer holds the lock first: it pushes 150 and commits the override. The webhook only
    // gets the lock once that writer is done.
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => {
      stripe.price = 150;
      db.override = 150;
      log.push("lock-acquired");
      return { acquired: true, value: await fn() };
    });
    jest.spyOn(svc, "syncStripeSubscriptionPrice").mockImplementation(async () => {
      log.push("resolve-price");
      const resolved = db.override ?? 349; // read INSIDE the lock, after the admin committed
      stripe.price = resolved;
      return { synced: true, oldAmount: 150, newAmount: resolved };
    });
    await svc.resyncPriceAfterCheckout("t1", session);
    expect(log).toEqual(["lock-acquired", "resolve-price"]);
    expect(stripe.price).toBe(150);
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
