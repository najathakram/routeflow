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

import { BillingCronService } from "./billing-cron.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

function make(
  data: {
    trials?: any[];
    graceSubs?: any[];
    downgrades?: any[];
    rollSubs?: any[];
    cancellations?: any[];
    cancelAddons?: any[];
    activeTeam?: number;
  } = {},
) {
  const tx = {
    tenantSubscription: { update: jest.fn().mockResolvedValue({}) },
    tenant: { update: jest.fn().mockResolvedValue({}) },
    user: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      count: jest.fn().mockResolvedValue(data.activeTeam ?? 5),
    },
  };
  const prisma = {
    tenant: {
      findMany: jest.fn().mockResolvedValue(data.trials ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    tenantSubscription: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(data.cancelAddons ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: data.cancelAddons?.length ?? 0 }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
  // route findMany call-sites by argument shape
  prisma.tenantSubscription.findMany.mockImplementation(({ where }: any) => {
    if (where.graceStartedAt) return Promise.resolve(data.graceSubs ?? []);
    if (where.downgradeEffectiveAt) return Promise.resolve(data.downgrades ?? []);
    if (where.cancelAtPeriodEnd) return Promise.resolve(data.cancellations ?? []);
    return Promise.resolve(data.rollSubs ?? []);
  });
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const entitlements = { invalidate: jest.fn() } as any;
  const tenantStatus = { invalidate: jest.fn() } as any;
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({
      definitions: [
        { planKey: "STARTER", monthlyPrice: 59, seatsIncluded: 1 },
        { planKey: "BUSINESS", monthlyPrice: 349, seatsIncluded: 15 },
      ],
    }),
  } as any;
  // Defaults to "unlimited" so grace windows expire exactly as they did before the
  // CUSTOMERS soft-cap; the tests below narrow it where the cap matters.
  const meters = {
    read: jest.fn().mockResolvedValue({
      meter: "CUSTOMERS",
      used: 0,
      included: null,
      remaining: null,
      resetsAt: null,
    }),
  } as any;
  const svc = new BillingCronService(prisma, events, entitlements, tenantStatus, catalog, meters);
  return { svc, prisma, tx, events, entitlements, tenantStatus, meters };
}

const emitted = (events: any) => events.emit.mock.calls.map((c: any[]) => c[1]);
const deltaOf = (events: any, type: string) => {
  const c = events.emit.mock.calls.find((x: any[]) => x[1] === type);
  return c ? c[3]?.amountDelta : undefined;
};

describe("BillingCronService", () => {
  it("expireTrials flips expired trials to READ_ONLY (not SUSPENDED) + emits trial.expired", async () => {
    const { svc, prisma, events, tenantStatus } = make({ trials: [{ id: "t1" }] });
    await svc.expireTrials();
    expect(prisma.tenant.update.mock.calls[0][0].data).toMatchObject({
      status: "READ_ONLY",
      readOnlyReason: "trial_expired",
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.TRIAL_EXPIRED);
    expect(tenantStatus.invalidate).toHaveBeenCalledWith("t1");
  });

  it("expireGrace clears grace windows older than 7 days", async () => {
    const { svc, prisma, events } = make({ graceSubs: [{ tenantId: "t1" }] });
    await svc.expireGrace();
    expect(prisma.tenantSubscription.update.mock.calls[0][0].data).toEqual({
      graceStartedAt: null,
      graceMeter: null,
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.GRACE_EXPIRED);
  });

  it("expireGrace keeps an expired CUSTOMERS window in place while the tenant is still over cap", async () => {
    const { svc, prisma, events, meters } = make({
      graceSubs: [{ tenantId: "t1", graceMeter: "CUSTOMERS" }],
    });
    meters.read.mockResolvedValue({
      meter: "CUSTOMERS",
      used: 101,
      included: 100,
      remaining: 0,
      resetsAt: null,
    });

    await svc.expireGrace();

    // Clearing it would read as "no grace window was ever opened" to the customer-create
    // gate, which would open a fresh one on the next create — the cap could never engage.
    expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
    expect(emitted(events)).not.toContain(BILLING_EVENTS.GRACE_EXPIRED);
  });

  it("expireGrace clears a CUSTOMERS window once the tenant is back within cap", async () => {
    const { svc, prisma, events, meters } = make({
      graceSubs: [{ tenantId: "t1", graceMeter: "CUSTOMERS" }],
    });
    meters.read.mockResolvedValue({
      meter: "CUSTOMERS",
      used: 90,
      included: 100,
      remaining: 10,
      resetsAt: null,
    });

    await svc.expireGrace();

    expect(prisma.tenantSubscription.update.mock.calls[0][0].data).toEqual({
      graceStartedAt: null,
      graceMeter: null,
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.GRACE_EXPIRED);
  });

  it("applyScheduledDowngrades switches plan, frees non-retained seats, emits events", async () => {
    const { svc, tx, events, entitlements } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: ["u1"],
        },
      ],
      activeTeam: 5, // over the STARTER cap of 1
    });
    await svc.applyScheduledDowngrades();
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      planKey: "STARTER",
      basePriceSnapshot: 59, // re-snapshot the new price
      downgradeToPlanKey: null,
      downgradeEffectiveAt: null,
    });
    // MRR delta priced off the PINNED version (59 − 349).
    const planChanged = events.emit.mock.calls.find(
      (c: any[]) => c[1] === BILLING_EVENTS.PLAN_CHANGED,
    );
    expect(planChanged[3].amountDelta).toBe(-290);
    // Over the seat cap → deactivate active team users NOT on the retained list.
    expect(tx.user.updateMany.mock.calls[0][0].where).toMatchObject({
      status: "ACTIVE",
      id: { notIn: ["u1"] },
    });
    expect(emitted(events)).toEqual(
      expect.arrayContaining([BILLING_EVENTS.SEAT_FREED, BILLING_EVENTS.PLAN_CHANGED]),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("downgrade with an EMPTY retained list still frees seats when over cap (keeps only admins)", async () => {
    const { svc, tx } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
      activeTeam: 5,
    });
    await svc.applyScheduledDowngrades();
    // notIn [] matches all → deactivates every non-admin operator/driver.
    expect(tx.user.updateMany).toHaveBeenCalled();
    expect(tx.user.updateMany.mock.calls[0][0].where.id).toEqual({ notIn: [] });
  });

  it("downgrade WITHIN the new seat cap frees nobody", async () => {
    const { svc, tx } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
      activeTeam: 1, // == STARTER cap
    });
    await svc.applyScheduledDowngrades();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("applyScheduledCancellations flips cancelled+expired subs to READ_ONLY + emits a NEGATIVE churn delta", async () => {
    const { svc, prisma, events, tenantStatus } = make({
      cancellations: [{ tenantId: "t1", basePriceSnapshot: 349, discount: 10 }],
    });
    await svc.applyScheduledCancellations();
    expect(prisma.tenant.update.mock.calls[0][0].data).toMatchObject({
      status: "READ_ONLY",
      readOnlyReason: "subscription_cancelled",
    });
    expect(emitted(events)).toContain(BILLING_EVENTS.SUBSCRIPTION_CANCELED);
    // Ledger nets DOWN by the tenant's run-rate: base 349 − discount 10 = 339.
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-339);
    expect(tenantStatus.invalidate).toHaveBeenCalledWith("t1");
  });

  it("applyScheduledCancellations churn delta includes active add-ons + deactivates the add-on rows", async () => {
    const { svc, prisma, events } = make({
      cancellations: [{ tenantId: "t1", basePriceSnapshot: 349, discount: 10 }],
      cancelAddons: [{ priceSnapshot: 12, quantity: 2 }],
    });
    await svc.applyScheduledCancellations();
    // −(349 + 12×2 − 10) = −363.
    expect(deltaOf(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toBe(-363);
    // Rows follow the ledger: the removed add-ons are deactivated so a later reactivation
    // re-adds their delta symmetrically (no ledger drift).
    expect(prisma.tenantAddon.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", active: true },
      data: { active: false },
    });
  });

  it("rollCycles advances the billing period so meters bucket into the new cycle", async () => {
    const periodEnd = new Date("2026-06-01T00:00:00Z"); // in the past
    const { svc, prisma } = make({
      rollSubs: [{ tenantId: "t1", cycle: "MONTHLY", periodEnd }],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodStart).toEqual(periodEnd); // new period starts at the old end
    expect(data.periodEnd.getTime()).toBeGreaterThan(periodEnd.getTime()); // advanced ~1 month
  });
});
