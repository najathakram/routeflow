import { SubscriptionService } from "./subscription.service";

/**
 * SA-775 rollout: the web banners cannot call `autoLockAllowed`, so the subscription view carries ONE server-computed
 * boolean, `autoLockHeld`: true when the rollout pause holds every automatic lock a banner threatens (the unpaid-invoice
 * pause and the trial expiry). It is computed through the SAME gate the writers use; absent = today's behaviour.
 */
function viewWith(opts: { cls?: string | null; paused?: boolean | "throw"; noSwitch?: boolean }) {
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({ definitions: [], addonSkus: [] }),
  } as any;
  const prisma = {
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
    tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ class: opts.cls === undefined ? "PRODUCTION" : opts.cls }),
    },
  } as any;
  const isPaused = jest.fn(async () => {
    if (opts.paused === "throw") throw new Error("switch read failed");
    return opts.paused !== false;
  });
  const svc = new SubscriptionService(
    prisma,
    catalog,
    {
      resolve: jest
        .fn()
        .mockResolvedValue({ planKey: "TEAM", status: "ACTIVE", planVersionId: "v7" }),
    } as any,
    {} as any,
    undefined,
    undefined,
    opts.noSwitch ? undefined : ({ isPaused } as any),
  );
  return { run: () => svc.getSubscription("t1"), isPaused, prisma };
}

describe("SubscriptionService.getSubscription - autoLockHeld (SA-775 rollout)", () => {
  it("paused switch + PRODUCTION: true", async () => {
    const v = viewWith({ paused: true, cls: "PRODUCTION" });
    expect((await v.run()).autoLockHeld).toBe(true);
    expect(v.isPaused).toHaveBeenCalled();
  });

  it.each([null, "SOMETHING_NEW"])(
    "paused switch + class %p (unclassifiable): true (fail closed)",
    async (cls) => {
      expect((await viewWith({ paused: true, cls }).run()).autoLockHeld).toBe(true);
    },
  );

  it.each(["TEST", "DEMO", "INTERNAL"])(
    "paused switch + %s class: false (QA still locks)",
    async (cls) => {
      expect((await viewWith({ paused: true, cls }).run()).autoLockHeld).toBe(false);
    },
  );

  it("switch not paused: false", async () => {
    expect((await viewWith({ paused: false }).run()).autoLockHeld).toBe(false);
  });

  it("no switch injected (a bare unit spec): false, and the tenant row is never read", async () => {
    const v = viewWith({ noSwitch: true });
    expect((await v.run()).autoLockHeld).toBe(false);
    expect(v.prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});
