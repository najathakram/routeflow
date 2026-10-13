// @LeaderCron wraps the tick in an advisory lock; there is no database here, so the lock passes through.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { BillingCronService } from "./billing-cron.service";

/**
 * SA-733r5: "the trial sweeps and banners skip a catch-up subscription". A catch-up tenant is ACTIVE (its Stripe
 * subscription is `trialing`, its Tenant row is not), and every trial sweep selects `Tenant.status = TRIAL` - so it
 * is never expired, warned or emailed. Pinned with a store that HONOURS the status predicate.
 */
const PAST = new Date("2026-10-01T00:00:00Z");
const tenants = [
  // the catch-up tenant: ACTIVE, with a stale trialEndsAt left over from its real trial
  { id: "t_catchup", status: "ACTIVE", trialEndsAt: PAST, deletedAt: null },
  { id: "t_real_trial", status: "TRIAL", trialEndsAt: PAST, deletedAt: null },
];

function make() {
  const findMany = jest.fn(async ({ where }: any) =>
    tenants.filter(
      (t) =>
        (where.status ? t.status === where.status : true) &&
        !t.deletedAt &&
        (where.trialEndsAt?.lt ? t.trialEndsAt < where.trialEndsAt.lt : true),
    ),
  );
  const update = jest.fn().mockResolvedValue({ count: 1 }); // expireTrials' compare-and-swap (updateMany)
  const prisma: any = { tenant: { findMany, updateMany: update } };
  const events: any = { emit: jest.fn() };
  const notification: any = { notifyTrialEnding: jest.fn().mockResolvedValue(undefined) };
  const svc = new BillingCronService(
    prisma,
    events,
    { invalidate: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    {} as any,
    {} as any,
    notification,
    {} as any,
    { isConfigured: false } as any,
    { applyDue: jest.fn() } as any,
  );
  return { svc, update, events, notification };
}

describe("catch-up tenants and the trial sweeps", () => {
  it("expireTrials selects only status TRIAL: the ACTIVE catch-up tenant is never moved to READ_ONLY", async () => {
    const h = make();
    await h.svc.expireTrials();
    expect(h.update.mock.calls.map((c) => c[0].where.id)).toEqual(["t_real_trial"]);
    expect(h.notification.notifyTrialEnding.mock.calls.map((c: any[]) => c[0])).toEqual([
      "t_real_trial",
    ]);
  });

  it("warnTrialsEnding never selects a non-TRIAL tenant", async () => {
    const h = make();
    await h.svc.warnTrialsEnding();
    for (const call of (h.svc as any).prisma.tenant.findMany.mock.calls) {
      expect(call[0].where.status).toBe("TRIAL");
    }
    expect(
      h.notification.notifyTrialEnding.mock.calls.map((c: any[]) => c[0]).includes("t_catchup"),
    ).toBe(false);
  });
});
