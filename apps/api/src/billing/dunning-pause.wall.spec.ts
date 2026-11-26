import { clearPauseCollection, reconcilePauseCollection } from "./dunning-pause";

/**
 * W-1464 R-305 m2: removing a dunning pause turns renewal charges back on, so it sits behind the live-payments wall.
 * Setting a pause only reduces what is charged and stays unwalled.
 */
function deps(tenantClass: string | null) {
  const stripe = {
    updateSubscription: jest.fn().mockResolvedValue({}),
    getSubscription: jest.fn(),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const auditLog = { create: jest.fn().mockResolvedValue({}) };
  const tenant = { findUnique: jest.fn(async () => ({ class: tenantClass })) };
  const prisma: any = { tenant, auditLog };
  return {
    d: { prisma, stripe, logger, mode: () => "enforced", once: () => true } as any,
    stripe,
    logger,
    auditLog,
  };
}
const exit = {
  tenantId: "t1",
  stripeSubId: "sub_1",
  exitAt: new Date("2026-11-26T00:00:00Z"),
} as any;
const held = (a: { create: jest.Mock }) =>
  a.create.mock.calls.map((c) => c[0].data).filter((x) => x.action === "LIVE_PAYMENTS_HELD");

describe("clearPauseCollection (the unpause arm)", () => {
  it("a PRODUCTION business still has its pause removed", async () => {
    const { d, stripe } = deps("PRODUCTION");
    await expect(clearPauseCollection(d, exit)).resolves.toBe(true);
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
  });

  it.each([["TEST"], ["DEMO"], ["INTERNAL"], [null]])(
    "a %s business is held, no Stripe call, and even a throwOnError webhook is acknowledged",
    async (cls) => {
      const { d, stripe, auditLog } = deps(cls as string | null);
      await expect(clearPauseCollection(d, exit, { throwOnError: true })).resolves.toBe(false);
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
      expect(held(auditLog)).toHaveLength(1);
    },
  );
});

describe("reconcilePauseCollection (the unpause arm of the reconciler)", () => {
  function world(tenantClass: string | null, localPaused: boolean, stripePaused: boolean) {
    const base = deps(tenantClass);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      tenant: base.d.prisma.tenant,
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          pausedAt: localPaused ? new Date() : null,
          stripeSubId: "sub_1",
        }),
      },
    };
    base.d.prisma.$transaction = jest.fn(async (fn: any) => fn(tx));
    base.d.prisma.tenantSubscription = {
      findMany: jest
        .fn()
        .mockResolvedValueOnce([{ tenantId: "t1", stripeSubId: "sub_1" }])
        .mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
    };
    base.stripe.getSubscription.mockResolvedValue({
      status: "active",
      pause_collection: stripePaused ? { behavior: "void" } : null,
    });
    return base;
  }

  it("a PRODUCTION business with a stray Stripe pause is unpaused", async () => {
    const w = world("PRODUCTION", false, true);
    await reconcilePauseCollection(w.d, new Date("2026-11-26T01:00:00Z"));
    expect(w.stripe.updateSubscription).toHaveBeenCalledWith(
      "sub_1",
      { pause_collection: "" },
      expect.anything(),
    );
  });

  it("a TEST business with a stray Stripe pause is held, not unpaused", async () => {
    const w = world("TEST", false, true);
    await reconcilePauseCollection(w.d, new Date("2026-11-26T01:00:00Z"));
    expect(w.stripe.updateSubscription).not.toHaveBeenCalled();
    expect(held(w.auditLog)).toHaveLength(1);
  });

  it("the SET arm (local paused, Stripe not) stays unwalled", async () => {
    const w = world("TEST", true, false);
    await reconcilePauseCollection(w.d, new Date("2026-11-26T01:00:00Z"));
    expect(w.stripe.updateSubscription).toHaveBeenCalledWith(
      "sub_1",
      { pause_collection: { behavior: "void" } },
      expect.anything(),
    );
  });
});
