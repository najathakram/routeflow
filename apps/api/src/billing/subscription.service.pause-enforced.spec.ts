import { SubscriptionService } from "./subscription.service";

/**
 * SA-733r6 (B4) B2: the banner must not threaten a pause that will never happen. `pauseEnforced` is decided by the
 * SERVER: true only when BILLING_PAUSE_MODE is "enforced" (B3 never pauses in dark / off; the default is dark).
 */
function viewWith(mode: string | undefined) {
  const prev = process.env.BILLING_PAUSE_MODE;
  if (mode === undefined) delete process.env.BILLING_PAUSE_MODE;
  else process.env.BILLING_PAUSE_MODE = mode;
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue({ definitions: [], addonSkus: [] }),
  } as any;
  const prisma = {
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
    tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  const svc = new SubscriptionService(
    prisma,
    catalog,
    {
      resolve: jest
        .fn()
        .mockResolvedValue({ planKey: "TEAM", status: "ACTIVE", planVersionId: "v7" }),
    } as any,
    {} as any,
  );
  return svc.getSubscription("t1").finally(() => {
    if (prev === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = prev;
  });
}

describe("SubscriptionService.getSubscription - pauseEnforced (B4 B2)", () => {
  it("is true only in enforced mode", async () => {
    expect((await viewWith("enforced")).pauseEnforced).toBe(true);
  });

  it.each(["dark", "off", "", "typo", undefined])(
    "is false for BILLING_PAUSE_MODE=%p (the default is dark)",
    async (mode) => {
      expect((await viewWith(mode as string | undefined)).pauseEnforced).toBe(false);
    },
  );
});
