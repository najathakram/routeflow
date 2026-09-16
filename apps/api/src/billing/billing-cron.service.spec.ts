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

import { Logger } from "@nestjs/common";
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
    // Finding 1 fallback path: a target plan missing from the tenant's PINNED version falls
    // back to the published catalog. Existing tests' targets (STARTER/BUSINESS) are always
    // found in the default getVersionForTenant definitions above, so this default is a no-op
    // for them — only the finding-1 tests below override it.
    getPublishedVersion: jest.fn().mockResolvedValue(null),
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
  return { svc, prisma, tx, events, entitlements, tenantStatus, catalog, meters };
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

  it("applyScheduledDowngrades only selects ACTIVE, non-deleted tenants (round 3, finding 8)", async () => {
    const { svc, prisma } = make({ downgrades: [] });
    await svc.applyScheduledDowngrades();
    // Without this filter the sweep applies a schedule left on a tenant that has already
    // churned (SUSPENDED/CANCELLED — its −MRR delta booked), booking a SECOND PLAN_CHANGED
    // delta the Σ-amountDelta rollup never heals, and deactivating a deleted tenant's staff.
    // Same clause applyScheduledCancellations carries in this file.
    const where = prisma.tenantSubscription.findMany.mock.calls[0][0].where;
    expect(where.tenant).toEqual({ status: "ACTIVE", deletedAt: null });
  });

  // B218: planKeyToEnum() now THROWS for a `downgradeToPlanKey` outside PLAN_KEYS instead of
  // silently writing STARTER (e.g. stale/migrated data, or a catalog row retired after the
  // downgrade was scheduled). A cron sweep must not let tenant N's bad row stop tenant N+1's
  // otherwise-valid scheduled downgrade from applying.
  it("REG-B218 applyScheduledDowngrades skips-and-logs ONE bad row (off-catalog target) and still applies the rest", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, tx, entitlements, tenantStatus } = make({
      downgrades: [
        {
          tenantId: "bad-1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "BOGUS", // not in PLAN_KEYS or LEGACY_PLAN_KEY_ALIASES
          retainedUserIds: [],
        },
        {
          tenantId: "good-1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: ["u1"],
        },
      ],
      activeTeam: 5,
    });

    await svc.applyScheduledDowngrades();

    // The bad row's write never reached the DB — planKeyToEnum() throws while building the
    // update's `data`, before tx.tenantSubscription.update is ever invoked for tenant
    // "bad-1" — but the sweep kept going: the good row right after it still applied in full.
    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
    expect(tx.tenantSubscription.update.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "good-1" },
      data: { planKey: "STARTER" },
    });
    expect(entitlements.invalidate).toHaveBeenCalledWith("good-1");
    expect(entitlements.invalidate).not.toHaveBeenCalledWith("bad-1");
    expect(tenantStatus.invalidate).not.toHaveBeenCalledWith("bad-1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("tenant=bad-1"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("BOGUS"));

    errorSpy.mockRestore();
  });

  // F2 (W1 review-fix round): the catch around applyScheduledDowngrades' per-tenant
  // $transaction was, pre-fix, broad enough to swallow EVERY error class — a pool
  // exhaustion, a Prisma error, any unrelated failure — and log it as if it were a bad
  // plan key, so the sweep reported success while masking a real infrastructure failure.
  // The B218 skip-and-continue behaviour above (an unresolvable plan key) must stay
  // exactly as it is; everything else must now propagate instead.
  it("REG-F2 applyScheduledDowngrades PROPAGATES a non-plan-key failure instead of logging it as a bad plan key", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, tx } = make({
      downgrades: [
        {
          tenantId: "infra-1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER", // a perfectly valid plan key — NOT the failure here
          retainedUserIds: [],
        },
      ],
      activeTeam: 5,
    });
    // A Prisma-style failure (e.g. pool exhaustion, P2025) thrown from inside the
    // transaction — NOT planKeyToEnum()'s unresolvable-key Error.
    const dbError = Object.assign(new Error("Connection pool timeout"), { code: "P2024" });
    tx.tenantSubscription.update.mockRejectedValueOnce(dbError);

    await expect(svc.applyScheduledDowngrades()).rejects.toThrow("Connection pool timeout");

    // Must never be reported through the "Skipping ... " bad-plan-key path — that would
    // disguise a real infrastructure failure as a data problem.
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Skipping"));

    errorSpy.mockRestore();
  });

  // Finding 1 (Lite-L2 review, money): an admin's downgrade to LITE is scheduled while the
  // tenant is still pinned to a pre-LITE catalog version. When the cron later applies it, the
  // OLD pinned version has no LITE row — pre-fix, findPlanDefinition() silently returned
  // undefined, planMonthly() fell back to 0, and the ledger booked a wildly wrong delta while
  // never re-pinning planVersionId, breaking later entitlement lookups too.
  it("REG-1 an ACTIVE tenant's downgrade to LITE re-pins planVersionId to the version that actually defines LITE and books the real delta", async () => {
    const { svc, tx, catalog, events } = make({
      downgrades: [
        {
          tenantId: "t1",
          planKey: "GROWTH",
          planVersionId: "v11",
          downgradeToPlanKey: "LITE",
          retainedUserIds: [],
        },
      ],
    });
    catalog.getVersionForTenant.mockResolvedValue({
      id: "v11",
      definitions: [{ planKey: "GROWTH", monthlyPrice: 249, seatsIncluded: 10 }],
    });
    catalog.getPublishedVersion.mockResolvedValue({
      id: "v12",
      definitions: [
        { planKey: "GROWTH", monthlyPrice: 249, seatsIncluded: 10 },
        { planKey: "LITE", monthlyPrice: 99, seatsIncluded: 3 },
      ],
    });

    await svc.applyScheduledDowngrades();

    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      planKey: "LITE",
      planVersionId: "v12",
      basePriceSnapshot: 99,
    });
    expect(deltaOf(events, BILLING_EVENTS.PLAN_CHANGED)).toBe(-150); // 99 − 249
  });

  it("REG-1 a target plan missing from every resolvable catalog version is skipped-and-logged, not silently applied", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, tx, catalog, entitlements } = make({
      downgrades: [
        {
          tenantId: "bad-1",
          planKey: "GROWTH",
          planVersionId: "v11",
          downgradeToPlanKey: "GHOST",
          retainedUserIds: [],
        },
        {
          tenantId: "good-1",
          planKey: "BUSINESS",
          planVersionId: "v7",
          downgradeToPlanKey: "STARTER",
          retainedUserIds: [],
        },
      ],
      activeTeam: 1,
    });
    catalog.getVersionForTenant.mockImplementation((versionId: string) =>
      Promise.resolve(
        versionId === "v11"
          ? {
              id: "v11",
              definitions: [{ planKey: "GROWTH", monthlyPrice: 249, seatsIncluded: 10 }],
            }
          : {
              id: "v7",
              definitions: [
                { planKey: "STARTER", monthlyPrice: 59, seatsIncluded: 1 },
                { planKey: "BUSINESS", monthlyPrice: 349, seatsIncluded: 15 },
              ],
            },
      ),
    );
    catalog.getPublishedVersion.mockResolvedValue({
      id: "v12",
      definitions: [{ planKey: "GROWTH", monthlyPrice: 249, seatsIncluded: 10 }],
    });

    await svc.applyScheduledDowngrades();

    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
    expect(tx.tenantSubscription.update.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "good-1" },
      data: { planKey: "STARTER" },
    });
    expect(entitlements.invalidate).not.toHaveBeenCalledWith("bad-1");
    expect(entitlements.invalidate).toHaveBeenCalledWith("good-1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("tenant=bad-1"));

    errorSpy.mockRestore();
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
      rollSubs: [{ tenantId: "t1", cycle: "MONTHLY", periodEnd, createdAt: periodEnd }],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodStart).toEqual(periodEnd); // new period starts at the old end
    expect(data.periodEnd.getTime()).toBeGreaterThan(periodEnd.getTime()); // advanced ~1 month
  });

  // B329's anchor-ratchet half stayed UNFIXED (correction 2026-09-13 — see the
  // rollCycles() comment in billing-cron.service.ts): the previously-landed fix used
  // TenantSubscription.createdAt as the anchor day, but createdAt is not a safe billing
  // anchor — 7 call sites create that row, several unrelated to subscribing (e.g.
  // customers.service.ts's maybeStartCustomerGrace(), billing.service.ts's
  // ensureStripeCustomer()) — so a tenant whose row was minted by one of those would have
  // every future period computed from the wrong date. rollCycles() still re-derives the
  // clamp day from the already-clamped periodEnd on every tick and therefore still
  // ratchets an anchor day down after a short month clips it, exactly like master.
  // addMonthsUtc already supports the anchorDay parameter that would fix this (full
  // coverage in billing-math.spec.ts) — it just needs an immutable, never-clamped
  // anchorDay column on TenantSubscription to pass it, which does not exist yet.
  it.todo(
    "rollCycles preserves the tenant's original anchor day across repeated short-month clips, never ratcheting down — blocked on a persisted anchorDay column; no safe anchor source exists today (createdAt is not the billing anchor)",
  );

  it("rollCycles preserves the period's time-of-day instead of collapsing to midnight — B329 (2)", async () => {
    const periodEnd = new Date("2026-01-15T09:30:15.250Z");
    const { svc, prisma } = make({
      rollSubs: [{ tenantId: "t1", cycle: "MONTHLY", periodEnd, createdAt: periodEnd }],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-02-15T09:30:15.250Z");
  });

  it("rollCycles guard: a mid-month anchor at midnight rolls byte-identically (no clip, nothing to preserve) — B329 (4)", async () => {
    const periodEnd = new Date("2026-03-15T00:00:00.000Z");
    const { svc, prisma } = make({
      rollSubs: [{ tenantId: "t1", cycle: "MONTHLY", periodEnd, createdAt: periodEnd }],
    });
    await svc.rollCycles();
    const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(data.periodEnd.toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });
});
