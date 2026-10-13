/**
 * Go-live M2 / M4: the admin status -> CANCELLED and the tenant delete share ONE Stripe gate.
 *  - the Stripe read happens BEFORE the transaction (never inside it, never under the tenant row lock),
 *    with a short timeout and ONE retry;
 *  - the stripeSubId read before is compared inside the transaction, under FOR UPDATE: a change -> 409 retry;
 *  - allowed ONLY when Stripe says 404 / resource_missing, or a TERMINAL status (canceled, incomplete_expired).
 *    `paused` and `incomplete` can come back, so they count as live and are refused.
 * Stripe is a mock; nothing here can reach a real account.
 */
import { Logger } from "@nestjs/common";
import { PlatformAdminService } from "./platform-admin.service";
import { createMockPrisma } from "../testing/prisma-mock";

const TENANT_ID = "tenant-1";

type Subs = { pre: string | null; inTx?: string | null };

function make(subs: Subs, opts: { configured?: boolean; status?: string } = {}) {
  const prisma: any = createMockPrisma();
  let inTx = false;
  const txSub = jest.fn(async () => ({
    stripeSubId: subs.inTx === undefined ? subs.pre : subs.inTx,
  }));
  prisma.tenantSubscription = {
    // the plain, pre-transaction read of the tenant's subscription id
    findUnique: jest.fn(async () => (inTx ? txSub() : { stripeSubId: subs.pre })),
    upsert: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({}),
  };
  prisma.tenant.findUnique.mockResolvedValue({
    id: TENANT_ID,
    slug: "acme",
    status: opts.status ?? "SUSPENDED",
  });
  prisma.tenant.findUniqueOrThrow.mockResolvedValue({
    id: TENANT_ID,
    slug: "acme",
    plan: "STARTER",
    status: opts.status ?? "SUSPENDED",
    readOnlyReason: null,
    class: "PRODUCTION",
    deletedAt: null,
    subscription: {
      planKey: "STARTER",
      basePriceSnapshot: 99,
      discount: 0,
      couponFull: false,
      stripeSubId: subs.inTx === undefined ? subs.pre : subs.inTx,
    },
  });
  prisma.tenant.update.mockResolvedValue({
    id: TENANT_ID,
    slug: "acme",
    status: "CANCELLED",
    deletedAt: new Date(),
  });
  const stripeCalls: boolean[] = []; // was each getSubscription call made inside the transaction?
  const stripe: any = {
    isConfigured: opts.configured ?? true,
    getSubscription: jest.fn(async () => {
      stripeCalls.push(inTx);
      return { status: "canceled" };
    }),
  };
  prisma.$transaction.mockImplementation(async (fn: any) => {
    inTx = true;
    try {
      return await fn({ ...prisma, tenantSubscription: prisma.tenantSubscription });
    } finally {
      inTx = false;
    }
  });
  const svc = new PlatformAdminService(
    prisma,
    {} as any,
    { get: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { emit: jest.fn().mockResolvedValue({}) } as any,
    {} as any,
    { invalidate: jest.fn() } as any,
    { log: jest.fn().mockResolvedValue(undefined) } as any,
    { priceSubscription: jest.fn().mockReturnValue(0) } as any,
    {} as any,
    {} as any,
    {} as any,
    stripe,
  );
  return { svc, prisma, stripe, stripeCalls };
}

type Op = [string, (svc: PlatformAdminService) => Promise<unknown>];
const OPS: Op[] = [
  [
    "updateStatus CANCELLED",
    (s) => s.updateStatus(TENANT_ID, { status: "CANCELLED" } as any, "a1"),
  ],
  ["deleteTenant", (s) => s.deleteTenant(TENANT_ID, "a1")],
];
const written = (prisma: any) => prisma.tenant.update.mock.calls.length > 0;
const code = (e: any) => e?.getResponse?.()?.code;

beforeEach(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe.each(OPS)("%s - the shared Stripe gate", (_name, run) => {
  it("no stripeSubId: allowed, Stripe is never read", async () => {
    const { svc, prisma, stripe } = make({ pre: null });
    await run(svc);
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(written(prisma)).toBe(true);
  });

  it("Stripe 404 / resource_missing: allowed", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription.mockRejectedValue({ code: "resource_missing", statusCode: 404 });
    await run(svc);
    expect(written(prisma)).toBe(true);
    expect(stripe.getSubscription).toHaveBeenCalledTimes(1); // a 404 is an answer: not retried
  });

  it.each(["canceled", "incomplete_expired"])("terminal status %s: allowed", async (status) => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription.mockResolvedValue({ status });
    await run(svc);
    expect(written(prisma)).toBe(true);
  });

  it.each(["paused", "incomplete", "active", "trialing", "past_due", "unpaid"])(
    "non-terminal status %s counts as LIVE: 409 TENANT_CANCEL_SUBSCRIPTION_FIRST, nothing written",
    async (status) => {
      const { svc, prisma, stripe } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({ status });
      const err: any = await run(svc).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(code(err)).toBe("TENANT_CANCEL_SUBSCRIPTION_FIRST");
      expect(written(prisma)).toBe(false);
    },
  );

  it("a Stripe read error is retried ONCE, then 409 CONCURRENT_UPDATE (retry), nothing written", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription.mockRejectedValue(new Error("network"));
    const err: any = await run(svc).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(code(err)).toBe("CONCURRENT_UPDATE");
    expect(stripe.getSubscription).toHaveBeenCalledTimes(2);
    expect(written(prisma)).toBe(false);
  });

  it("a read that fails once and then answers canceled is allowed", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ status: "canceled" });
    await run(svc);
    expect(written(prisma)).toBe(true);
  });

  it("a Stripe read that HANGS times out (short timeout), is retried once, then 409 CONCURRENT_UPDATE", async () => {
    jest.useFakeTimers();
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription.mockImplementation(() => new Promise(() => undefined));
    const p = run(svc).catch((e) => e);
    await jest.advanceTimersByTimeAsync(60_000);
    const err: any = await p;
    expect(code(err)).toBe("CONCURRENT_UPDATE");
    expect(stripe.getSubscription).toHaveBeenCalledTimes(2);
    expect(written(prisma)).toBe(false);
  });

  it("Stripe not configured with a stored subscription fails closed: TENANT_CANCEL_SUBSCRIPTION_FIRST", async () => {
    const { svc, prisma } = make({ pre: "sub_1" }, { configured: false });
    const err: any = await run(svc).catch((e) => e);
    expect(code(err)).toBe("TENANT_CANCEL_SUBSCRIPTION_FIRST");
    expect(written(prisma)).toBe(false);
  });

  it("the stripeSubId CHANGED between the read and the lock: 409 CONCURRENT_UPDATE, nothing written", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_old", inTx: "sub_new" });
    stripe.getSubscription.mockResolvedValue({ status: "canceled" });
    const err: any = await run(svc).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(code(err)).toBe("CONCURRENT_UPDATE");
    expect(written(prisma)).toBe(false);
  });

  it("a subscription ATTACHED between the read and the lock (none before) is also a 409 retry", async () => {
    const { svc, prisma } = make({ pre: null, inTx: "sub_new" });
    const err: any = await run(svc).catch((e) => e);
    expect(code(err)).toBe("CONCURRENT_UPDATE");
    expect(written(prisma)).toBe(false);
  });

  it("Stripe is NEVER called inside the transaction", async () => {
    const { svc, stripeCalls } = make({ pre: "sub_1" });
    await run(svc); // the harness records, at call time, whether a transaction was open
    expect(stripeCalls.length).toBeGreaterThan(0);
    expect(stripeCalls.every((inside) => inside === false)).toBe(true);
  });
});

describe("updateStatus - other targets never read Stripe", () => {
  it.each(["SUSPENDED", "READ_ONLY", "ACTIVE"])("%s does not consult Stripe", async (status) => {
    const { svc, stripe } = make({ pre: "sub_1" }, { status: "TRIAL" });
    await svc.updateStatus(TENANT_ID, { status } as any, "a1").catch(() => undefined);
    expect(stripe.getSubscription).not.toHaveBeenCalled();
  });
});
