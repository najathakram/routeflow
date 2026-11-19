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
import { NO_STORED_CUSTOMER_REASON } from "./stripe-termination-gate";

const TENANT_ID = "tenant-1";

type Subs = { pre: string | null; inTx?: string | null };

function make(
  subs: Subs,
  opts: { configured?: boolean; status?: string; customer?: string | null } = {},
) {
  const prisma: any = createMockPrisma();
  let inTx = false;
  const txSub = jest.fn(async () => ({
    stripeSubId: subs.inTx === undefined ? subs.pre : subs.inTx,
  }));
  prisma.tenantSubscription = {
    // the plain, pre-transaction read of the tenant's subscription id
    findUnique: jest.fn(async () =>
      inTx
        ? txSub()
        : {
            stripeSubId: subs.pre,
            stripeCustomerId: opts.customer === undefined ? "cus_1" : opts.customer,
          },
    ),
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
  const done = { id: TENANT_ID, slug: "acme", status: "CANCELLED", deletedAt: new Date() };
  prisma.tenant.update.mockResolvedValue(done);
  // deleteTenant: the guarded write (where status SUSPENDED) then a re-read of the row it wrote
  prisma.tenant.updateMany.mockResolvedValue({ count: 1 });
  // B430: deleteTenant reads the tenant's ledger sum inside the transaction, after the guarded write.
  prisma.billingEvent = {
    aggregate: jest.fn().mockResolvedValue({ _sum: { amountDelta: null } }),
  };
  const stripeCalls: boolean[] = []; // was each getSubscription call made inside the transaction?
  const auditLog = jest.fn().mockResolvedValue(undefined);
  const stripe: any = {
    isConfigured: opts.configured ?? true,
    getCustomer: jest.fn(async () => {
      stripeCalls.push(inTx);
      return { id: "cus_1" };
    }),
    getSubscription: jest.fn(async () => {
      stripeCalls.push(inTx);
      return { status: "canceled", customer: "cus_1" };
    }),
  };
  const txClients: unknown[] = []; // the transaction client each $transaction callback received
  prisma.$transaction.mockImplementation(async (fn: any) => {
    inTx = true;
    try {
      const tx = { ...prisma, tenantSubscription: prisma.tenantSubscription };
      txClients.push(tx);
      return await fn(tx);
    } finally {
      inTx = false;
    }
  });
  const emit = jest.fn().mockResolvedValue({});
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
    { emit } as any,
    {} as any,
    { invalidate: jest.fn() } as any,
    { log: auditLog } as any,
    { priceSubscription: jest.fn().mockReturnValue(0) } as any,
    {} as any,
    {} as any,
    {} as any,
    stripe,
  );
  return { svc, prisma, stripe, stripeCalls, auditLog, emit, txClients };
}

type Op = [string, (svc: PlatformAdminService) => Promise<unknown>];
const OPS: Op[] = [
  [
    "updateStatus CANCELLED",
    (s) => s.updateStatus(TENANT_ID, { status: "CANCELLED" } as any, "a1"),
  ],
  ["deleteTenant", (s) => s.deleteTenant(TENANT_ID, "a1")],
];
const written = (prisma: any) =>
  prisma.tenant.update.mock.calls.length > 0 || prisma.tenant.updateMany.mock.calls.length > 0;
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
    expect(stripe.getCustomer).not.toHaveBeenCalled();
    expect(written(prisma)).toBe(true);
  });

  const missing = { code: "resource_missing", statusCode: 404 };
  const rows = (auditLog: jest.Mock, action: string) =>
    auditLog.mock.calls.map((c) => c[0]).filter((r) => r.action === action);

  it("Stripe sub 404 + the customer EXISTS: allowed, with exactly one audit row saying so", async () => {
    const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" });
    stripe.getSubscription.mockRejectedValue(missing);
    await run(svc);
    expect(written(prisma)).toBe(true);
    expect(stripe.getSubscription).toHaveBeenCalledTimes(1); // a 404 is an answer: not retried
    expect(stripe.getCustomer).toHaveBeenCalledWith("cus_1");
    const r = rows(auditLog, "STRIPE_SUB_NOT_FOUND_TERMINATED");
    expect(r).toHaveLength(1);
    expect(r[0].meta).toMatchObject({ note: "stripe sub not found; customer present" });
  });

  it("Stripe sub 404 + the customer is 404 too: 409 STRIPE_ACCOUNT_MISMATCH, ops alert, nothing written", async () => {
    const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" });
    stripe.getSubscription.mockRejectedValue(missing);
    stripe.getCustomer.mockRejectedValue(missing);
    const err: any = await run(svc).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(code(err)).toBe("STRIPE_ACCOUNT_MISMATCH");
    expect(err.getResponse().message).toBe(
      "Stripe can't find this tenant's subscription or customer. Check the Stripe key and mode before cancelling.",
    );
    expect(written(prisma)).toBe(false);
    const a = rows(auditLog, "STRIPE_KEY_MODE_MISMATCH");
    expect(a).toHaveLength(1);
    expect(a[0].meta.message).toBe("Stripe key/mode mismatch suspected");
    expect(rows(auditLog, "STRIPE_SUB_NOT_FOUND_TERMINATED")).toHaveLength(0);
  });

  it("Stripe sub 404 + a customer read error (after one retry): 409 CONCURRENT_UPDATE, nothing written", async () => {
    const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" });
    stripe.getSubscription.mockRejectedValue(missing);
    stripe.getCustomer.mockRejectedValue(new Error("network"));
    const err: any = await run(svc).catch((e) => e);
    expect(code(err)).toBe("CONCURRENT_UPDATE");
    expect(err.getResponse().reason).toBe("STRIPE_UNCONFIRMED");
    expect(stripe.getCustomer).toHaveBeenCalledTimes(2);
    expect(written(prisma)).toBe(false);
    expect(rows(auditLog, "STRIPE_SUB_NOT_FOUND_TERMINATED")).toHaveLength(0);
  });

  describe("a stripeSubId but NO stripeCustomerId (#477b): the customer check cannot run", () => {
    it.each([null, ""])(
      "sub 404 + stored customer %p: refused as the no-stored-customer owner refusal (reason NO_STORED_CUSTOMER), NO key/mode audit row, never allowed blind",
      async (customer) => {
        const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" }, { customer });
        stripe.getSubscription.mockRejectedValue(missing);
        const err: any = await run(svc).catch((e) => e);
        expect(err.getStatus()).toBe(409);
        expect(code(err)).toBe("STRIPE_SUBSCRIPTION_OWNER_MISMATCH");
        expect(err.getResponse().reason).toBe(NO_STORED_CUSTOMER_REASON);
        expect(err.getResponse().message).toMatch(/no Stripe customer on file/);
        expect(stripe.getCustomer).not.toHaveBeenCalled();
        expect(written(prisma)).toBe(false);
        expect(rows(auditLog, "STRIPE_KEY_MODE_MISMATCH")).toHaveLength(0);
        expect(rows(auditLog, "STRIPE_SUB_NOT_FOUND_TERMINATED")).toHaveLength(0);
        expect(auditLog).not.toHaveBeenCalled();
      },
    );

    it.each(["active", "past_due", "paused", "incomplete"])(
      "sub returned LIVE (%s): refused STRIPE_SUBSCRIPTION_OWNER_MISMATCH (ownership is judged first), nothing written",
      async (status) => {
        const { svc, prisma, stripe } = make({ pre: "sub_1" }, { customer: null });
        stripe.getSubscription.mockResolvedValue({ status, customer: "cus_x" });
        const err: any = await run(svc).catch((e) => e);
        expect(code(err)).toBe("STRIPE_SUBSCRIPTION_OWNER_MISMATCH");
        expect(err.getResponse().reason).toBe(NO_STORED_CUSTOMER_REASON);
        expect(written(prisma)).toBe(false);
      },
    );

    it("sub returned TERMINAL: REFUSED (never adopt the subscription's customer as the tenant's), nothing written, no audit row", async () => {
      const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" }, { customer: null });
      stripe.getSubscription.mockResolvedValue({ status: "canceled", customer: "cus_x" });
      const err: any = await run(svc).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(code(err)).toBe("STRIPE_SUBSCRIPTION_OWNER_MISMATCH");
      expect(err.getResponse().message).toMatch(/no Stripe customer on file/);
      expect(err.getResponse().reason).toBe(NO_STORED_CUSTOMER_REASON);
      expect(written(prisma)).toBe(false);
      expect(auditLog).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.updateMany).not.toHaveBeenCalled();
    });

    it("sub read fails twice: 409 CONCURRENT_UPDATE (Stripe unconfirmed), nothing written", async () => {
      const { svc, prisma, stripe } = make({ pre: "sub_1" }, { customer: null });
      stripe.getSubscription.mockRejectedValue(new Error("network"));
      const err: any = await run(svc).catch((e) => e);
      expect(code(err)).toBe("CONCURRENT_UPDATE");
      expect(err.getResponse().reason).toBe("STRIPE_UNCONFIRMED");
      expect(stripe.getSubscription).toHaveBeenCalledTimes(2);
      expect(written(prisma)).toBe(false);
    });

    it("the refusal comes before any transaction, and every Stripe read is outside one", async () => {
      const { svc, prisma, stripeCalls } = make({ pre: "sub_1" }, { customer: null });
      await run(svc).catch(() => undefined); // refused (no stored customer); the harness still records each Stripe read
      expect(prisma.$transaction).not.toHaveBeenCalled(); // refused before any transaction opened
      expect(stripeCalls.length).toBeGreaterThan(0);
      expect(stripeCalls.every((inside) => inside === false)).toBe(true);
    });
  });

  describe("the subscription must BELONG to this tenant (owner check)", () => {
    const OWNER = "STRIPE_SUBSCRIPTION_OWNER_MISMATCH";
    const noWrites = (prisma: any, auditLog: jest.Mock) => {
      expect(written(prisma)).toBe(false);
      expect(auditLog).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
      expect(prisma.tenantSubscription.updateMany).not.toHaveBeenCalled();
    };
    const warned = () => (Logger.prototype.warn as jest.Mock).mock.calls.map((c) => String(c[0]));

    it("terminal sub whose customer (string) is another customer: refused, no write, no audit, warn names BOTH ids", async () => {
      const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({ status: "canceled", customer: "cus_other" });
      const err: any = await run(svc).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(code(err)).toBe(OWNER);
      expect(err.getResponse().message).toBe(
        "This subscription belongs to a different Stripe customer. Check the tenant's billing record before cancelling.",
      );
      expect(err.getResponse().reason).toBeUndefined(); // only the no-stored-customer refusal carries a reason
      noWrites(prisma, auditLog);
      const w = warned().filter((m) => m.includes("cus_other"));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("cus_1");
      expect(w[0]).toContain(TENANT_ID);
    });

    it("an EXPANDED customer object is read by .id: a different id is refused", async () => {
      const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({
        status: "canceled",
        customer: { id: "cus_other", object: "customer" },
      });
      const err: any = await run(svc).catch((e) => e);
      expect(code(err)).toBe(OWNER);
      noWrites(prisma, auditLog);
      const w = warned().find((m) => m.includes("cus_other"));
      expect(w).toContain("cus_1");
    });

    it("an expanded customer object with the SAME id is allowed", async () => {
      const { svc, prisma, stripe } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({
        status: "canceled",
        customer: { id: "cus_1", object: "customer" },
      });
      await run(svc);
      expect(written(prisma)).toBe(true);
    });

    it("metadata.tenantId present and different (customer matches): refused, the warn names the metadata tenant too", async () => {
      const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({
        status: "canceled",
        customer: "cus_1",
        metadata: { tenantId: "tenant-OTHER" },
      });
      const err: any = await run(svc).catch((e) => e);
      expect(code(err)).toBe(OWNER);
      noWrites(prisma, auditLog);
      const w = warned().find((m) => m.includes("tenant-OTHER"));
      expect(w).toContain("cus_1");
    });

    it("metadata.tenantId matching the tenant, or absent, with a matching customer: allowed as today", async () => {
      for (const metadata of [undefined, null, {}, { tenantId: "" }, { tenantId: TENANT_ID }]) {
        const { svc, prisma, stripe } = make({ pre: "sub_1" });
        stripe.getSubscription.mockResolvedValue({
          status: "canceled",
          customer: "cus_1",
          metadata,
        });
        await run(svc);
        expect(written(prisma)).toBe(true);
      }
    });

    it("a found subscription with NO customer field at all fails closed (never allowed)", async () => {
      const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({ status: "canceled" });
      const err: any = await run(svc).catch((e) => e);
      expect(code(err)).toBe(OWNER);
      noWrites(prisma, auditLog);
    });

    it("a LIVE subscription owned by another customer reports the owner mismatch, NOT cancel-first (ownership is judged before status)", async () => {
      const { svc, prisma, stripe, auditLog } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({ status: "active", customer: "cus_other" });
      const err: any = await run(svc).catch((e) => e);
      expect(code(err)).toBe(OWNER);
      noWrites(prisma, auditLog);
    });

    it("a LIVE subscription owned by THIS tenant is still cancel-first", async () => {
      const { svc, stripe } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({ status: "active", customer: "cus_1" });
      const err: any = await run(svc).catch((e) => e);
      expect(code(err)).toBe("TENANT_CANCEL_SUBSCRIPTION_FIRST");
    });
  });

  it("a terminal status needs no customer read and writes no not-found row", async () => {
    const { svc, stripe, auditLog } = make({ pre: "sub_1" });
    stripe.getSubscription.mockResolvedValue({ status: "canceled", customer: "cus_1" });
    await run(svc);
    expect(stripe.getCustomer).not.toHaveBeenCalled();
    expect(rows(auditLog, "STRIPE_SUB_NOT_FOUND_TERMINATED")).toHaveLength(0);
  });

  it.each(["canceled", "incomplete_expired"])("terminal status %s: allowed", async (status) => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription.mockResolvedValue({ status, customer: "cus_1" });
    await run(svc);
    expect(written(prisma)).toBe(true);
  });

  it.each(["paused", "incomplete", "active", "trialing", "past_due", "unpaid"])(
    "non-terminal status %s counts as LIVE: 409 TENANT_CANCEL_SUBSCRIPTION_FIRST, nothing written",
    async (status) => {
      const { svc, prisma, stripe } = make({ pre: "sub_1" });
      stripe.getSubscription.mockResolvedValue({ status, customer: "cus_1" });
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
    expect(err.getResponse().reason).toBe("STRIPE_UNCONFIRMED");
    expect(stripe.getSubscription).toHaveBeenCalledTimes(2);
    expect(written(prisma)).toBe(false);
  });

  it("a read that fails once and then answers canceled is allowed", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ status: "canceled", customer: "cus_1" });
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

  it("Stripe not configured with a stored subscription fails closed: 409 STRIPE_NOT_CONFIGURED, fixed copy", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" }, { configured: false });
    const err: any = await run(svc).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(code(err)).toBe("STRIPE_NOT_CONFIGURED");
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(written(prisma)).toBe(false);
  });

  const badKey = { type: "StripeAuthenticationError", statusCode: 401 };

  it("a Stripe 401 (bad key) on the subscription read is NOT retried: 409 STRIPE_NOT_CONFIGURED, nothing written", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription.mockRejectedValue(badKey);
    const err: any = await run(svc).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(code(err)).toBe("STRIPE_NOT_CONFIGURED");
    expect(stripe.getSubscription).toHaveBeenCalledTimes(1);
    expect(written(prisma)).toBe(false);
  });

  it.each([
    ["statusCode 403", { statusCode: 403 }],
    ["type StripePermissionError", { type: "StripePermissionError" }],
  ])(
    "a Stripe permission error (%s) is the bad-key refusal at once, not retried",
    async (_n, perm) => {
      const { svc, prisma, stripe } = make({ pre: "sub_1" });
      stripe.getSubscription.mockRejectedValue(perm);
      const err: any = await run(svc).catch((e) => e);
      expect(code(err)).toBe("STRIPE_NOT_CONFIGURED");
      expect(stripe.getSubscription).toHaveBeenCalledTimes(1);
      expect(written(prisma)).toBe(false);
    },
  );

  it("a Stripe 401 on the customer read (after a sub 404) is the same coded refusal, not retried", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_1" });
    stripe.getSubscription.mockRejectedValue({ code: "resource_missing", statusCode: 404 });
    stripe.getCustomer.mockRejectedValue(badKey);
    const err: any = await run(svc).catch((e) => e);
    expect(code(err)).toBe("STRIPE_NOT_CONFIGURED");
    expect(stripe.getCustomer).toHaveBeenCalledTimes(1);
    expect(written(prisma)).toBe(false);
  });

  it("the stripeSubId CHANGED between the read and the lock: 409 CONCURRENT_UPDATE, nothing written", async () => {
    const { svc, prisma, stripe } = make({ pre: "sub_old", inTx: "sub_new" });
    stripe.getSubscription.mockResolvedValue({ status: "canceled", customer: "cus_1" });
    const err: any = await run(svc).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(code(err)).toBe("CONCURRENT_UPDATE");
    // not a Stripe-read failure: no reason, so the web shows the generic 'tenant changed' text
    expect(err.getResponse().reason).toBeUndefined();
    expect(written(prisma)).toBe(false);
  });

  it("a subscription ATTACHED between the read and the lock (none before) is also a 409 retry", async () => {
    const { svc, prisma } = make({ pre: null, inTx: "sub_new" });
    const err: any = await run(svc).catch((e) => e);
    expect(code(err)).toBe("CONCURRENT_UPDATE");
    expect(err.getResponse().reason).toBeUndefined();
    expect(written(prisma)).toBe(false);
  });

  it("Stripe is NEVER called inside the transaction", async () => {
    const { svc, stripeCalls } = make({ pre: "sub_1" });
    await run(svc); // the harness records, at call time, whether a transaction was open
    expect(stripeCalls.length).toBeGreaterThan(0);
    expect(stripeCalls.every((inside) => inside === false)).toBe(true);
  });

  it("the customer read (after a sub 404) is outside the transaction too", async () => {
    const { svc, stripe, stripeCalls } = make({ pre: "sub_1" });
    stripe.getSubscription.mockImplementation(async () => {
      stripeCalls.push(false);
      throw { code: "resource_missing", statusCode: 404 };
    });
    await run(svc);
    expect(stripe.getCustomer).toHaveBeenCalledTimes(1);
    expect(stripeCalls.length).toBe(2);
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

describe("deleteTenant - the SUSPENDED check is re-proved under the row lock", () => {
  it("status moved to ACTIVE after the pre-read: the SAME 'suspend it first' 400 as the pre-check, nothing deleted", async () => {
    const { svc, prisma, stripe } = make({ pre: null });
    stripe.getSubscription.mockResolvedValue({ status: "canceled", customer: "cus_1" });
    prisma.tenant.updateMany.mockResolvedValue({ count: 0 }); // the guarded write finds an ACTIVE row
    const err: any = await svc.deleteTenant(TENANT_ID, "a1").catch((e) => e);
    // not CONCURRENT_UPDATE: the admin web words that as a Stripe-confirm retry, which would mislead here. A 400
    // maps to the fixed "Only a suspended tenant can be deleted" copy (deleteFailureCopy).
    expect(err.getStatus()).toBe(400);
    expect(err.message).toMatch(/must be suspended/);
    expect(prisma.tenant.updateMany.mock.calls[0][0].where).toEqual({
      id: TENANT_ID,
      status: "SUSPENDED",
    });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

// B430 / SA-1167 R1: a tenant is deleted with its ledger sum at zero. deleteTenant reads the sum under the
// row lock, after the guarded write, and books ONE SUBSCRIPTION_CANCELED true-up of -sum, or nothing at 0.
describe("deleteTenant - ledger true-up (B430)", () => {
  const sum = (prisma: any, v: unknown) =>
    prisma.billingEvent.aggregate.mockResolvedValue({ _sum: { amountDelta: v } });

  it("books one -100 true-up inside the transaction when the tenant still sums to +100", async () => {
    const { svc, prisma, emit, txClients } = make({ pre: null });
    sum(prisma, 100);
    await svc.deleteTenant(TENANT_ID, "a1");
    expect(prisma.billingEvent.aggregate).toHaveBeenCalledWith({
      _sum: { amountDelta: true },
      where: { tenantId: TENANT_ID },
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const [tenantId, type, payload, opts] = emit.mock.calls[0];
    expect(tenantId).toBe(TENANT_ID);
    expect(type).toBe("subscription.canceled");
    expect(payload).toEqual({
      fromStatus: "SUSPENDED",
      toStatus: "CANCELLED",
      appliedAt: expect.any(String),
      reason: "delete_ledger_true_up",
    });
    expect(opts.amountDelta).toBe(-100);
    expect(opts.actorId).toBe("a1");
    // the row joins the delete's own transaction client, not the root client (a spread copy, so identity matters)
    expect(txClients).toHaveLength(1);
    expect(opts.tx).toBe(txClients[0]);
    expect(opts.tx).not.toBe(prisma);
  });

  it("books the opposite sign when the tenant sums below zero", async () => {
    const { svc, prisma, emit } = make({ pre: null });
    sum(prisma, "-40.50");
    await svc.deleteTenant(TENANT_ID, "a1");
    expect(emit.mock.calls[0][3].amountDelta).toBe(40.5);
  });

  it.each([
    ["no events (null sum)", null],
    ["exactly 0", 0],
    ["0.004, which rounds to 0", 0.004],
    ["-0.004, which rounds to 0 (no -0 row)", -0.004],
  ])("books nothing when the ledger sum is %s", async (_label, v) => {
    const { svc, prisma, emit } = make({ pre: null });
    sum(prisma, v);
    await svc.deleteTenant(TENANT_ID, "a1");
    expect(emit).not.toHaveBeenCalled();
  });

  it("reads the sum only after the guarded write, and books nothing when that write refuses", async () => {
    const ok = make({ pre: null });
    sum(ok.prisma, 100);
    await ok.svc.deleteTenant(TENANT_ID, "a1");
    expect(ok.prisma.tenant.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      ok.prisma.billingEvent.aggregate.mock.invocationCallOrder[0],
    );

    const refused = make({ pre: null });
    sum(refused.prisma, 100);
    refused.prisma.tenant.updateMany.mockResolvedValue({ count: 0 });
    await refused.svc.deleteTenant(TENANT_ID, "a1").catch(() => undefined);
    expect(refused.prisma.billingEvent.aggregate).not.toHaveBeenCalled();
    expect(refused.emit).not.toHaveBeenCalled();
  });
});
