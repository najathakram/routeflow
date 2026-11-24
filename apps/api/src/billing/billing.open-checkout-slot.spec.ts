import { Logger } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError } from "../common/db-locks";
import { pinWallClock } from "../testing/pin-clock";

/**
 * W-1338 / SA-1267 PR-1: ONE open-session slot per tenant for the admin link and the tenant's own Pay now.
 * Stripe is an in-memory fake that models what matters here: newest-first list, a 24 h idempotency-key replay,
 * and `expire` refusing a session that is not open. The advisory lock is a per-key mutex (the real one is Postgres).
 */

const locked = { fail: null as null | Error, waits: [] as number[] };
const chains = new Map<string, Promise<unknown>>();
jest.mock("../common/db-locks", () => {
  const actual = jest.requireActual("../common/db-locks");
  return {
    ...actual,
    withAdvisoryLock: async (
      o: { family: string; key: string; waitMs?: number },
      fn: () => Promise<unknown>,
    ) => {
      locked.waits.push(o.waitMs ?? -1);
      if (locked.fail) throw locked.fail;
      const k = `${o.family}:${o.key}`;
      const run = (chains.get(k) ?? Promise.resolve()).then(async () => ({
        acquired: true,
        value: await fn(),
      }));
      chains.set(
        k,
        run.catch(() => undefined),
      );
      return run;
    },
  };
});

function fakeStripe(customerId = "cus_1") {
  const sessions: any[] = [];
  const replay = new Map<string, any>();
  let n = 0;
  const create = jest.fn(async (params: any, opts?: { idempotencyKey?: string }) => {
    const key = opts?.idempotencyKey;
    if (key && replay.has(key)) return replay.get(key);
    n += 1;
    const s = {
      id: `cs_${n}`,
      url: `https://pay.test/${n}`,
      status: "open",
      customer: params.customer,
      metadata: params.metadata,
      expires_at: params.expires_at,
      created: Math.floor(Date.now() / 1000),
      subscription: null as string | null,
      managed: params.managed_payments,
    };
    sessions.unshift(s);
    if (key) replay.set(key, s);
    return s;
  });
  const list = jest.fn(async (p: { customer?: string; status?: string }) => ({
    data: sessions.filter(
      (s) => (!p.customer || s.customer === p.customer) && (!p.status || s.status === p.status),
    ),
  }));
  const expire = jest.fn(async (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s || s.status !== "open") throw new Error("session is not open");
    s.status = "expired";
    return s;
  });
  const stripe: any = {
    isConfigured: true,
    client: { checkout: { sessions: { create, list, expire } } },
    getSubscription: jest.fn(),
    getCheckoutSession: jest.fn(async (id: string) => sessions.find((x) => x.id === id)),
    createCustomer: jest.fn(async () => ({ id: customerId })),
  };
  return { stripe, sessions, create, list, expire };
}

function make(
  opts: {
    unitAmount?: number;
    sub?: Record<string, unknown>;
    noCustomer?: boolean;
    unpriced?: boolean;
    stripeState?: ReturnType<typeof fakeStripe>;
    tenantId?: string;
  } = {},
) {
  const tenantId = opts.tenantId ?? "t1";
  const fake = opts.stripeState ?? fakeStripe();
  const price = { unit: opts.unitAmount ?? 9900 };
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({
        id: tenantId,
        slug: "acme",
        status: "ACTIVE",
        readOnlyReason: null,
        subscription: opts.noCustomer ? null : { stripeCustomerId: "cus_1" },
        config: { businessName: "Acme" },
      })),
    },
    user: { findMany: jest.fn(async () => []) },
    // `upsert` is ensureStripeCustomer's; no `update`, so a slot that writes a column (a URL, a snapshot) throws here.
    tenantSubscription: {
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({
        stripeCustomerId: opts.noCustomer ? null : "cus_1",
        stripeSubId: null,
        externalPayment: false,
        catchupState: null,
        catchupSessionId: null,
        ...opts.sub,
      })),
    },
  };
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => {
      if (opts.unpriced) throw new Error("no price");
      return { planKey: "STARTER" };
    }),
    checkoutPriceData: jest.fn(async (_t: string, interval: string) => {
      if (opts.unpriced) throw new Error("no price");
      return {
        currency: "usd",
        product_data: { name: "RouteFlow Starter" },
        unit_amount: price.unit,
        recurring: { interval },
      };
    }),
  };
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => ({ lineItems: [], skus: [] })),
  };
  const billing = new BillingService(
    prisma,
    fake.stripe,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn() } as any,
    pricing,
    {} as any,
    {} as any,
    mutations,
  );
  return { billing, prisma, price, ...fake, fake };
}

beforeEach(() => {
  pinWallClock();
  locked.fail = null;
  locked.waits = [];
  chains.clear();
});
afterEach(() => jest.useRealTimers());

const admin = { surface: "ADMIN_LINK" as const };
const self = { surface: "TENANT_SELF" as const };

describe("W-1338 PR-1 — the one open-session slot", () => {
  it("L1: a double click on the admin link makes ONE Stripe session and returns the same link", async () => {
    const h = make();
    const [a, b] = await Promise.all([
      h.billing.createCheckoutSession("t1", admin),
      h.billing.createCheckoutSession("t1", admin),
    ]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("L11: the admin link and the tenant's Pay now at once make ONE session, one open in the fake", async () => {
    const h = make();
    await Promise.all([
      h.billing.createCheckoutSession("t1", admin),
      h.billing.createCheckoutSession("t1", self),
    ]);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sessions.filter((s) => s.status === "open")).toHaveLength(1);
  });

  it("the tenant's own click waits the short self-serve budget, the admin link the admin one", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", self);
    await h.billing.cancelOpenLink("t1");
    await h.billing.createCheckoutSession("t1", admin);
    expect(locked.waits).toEqual([2_500, 20_000, 20_000]);
  });

  it("a changed price expires the old session and opens a new one at the new amount", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", admin);
    h.price.unit = 12345; // a custom fee quoted since (L20: the fee, not the catalog, is what is priced)
    const second = await h.billing.createCheckoutSession("t1", admin);
    expect(h.expire).toHaveBeenCalledWith("cs_1");
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ sessionId: "cs_2" });
    expect(h.create.mock.calls[1][0].line_items[0].price_data.unit_amount).toBe(12345);
  });

  it("L13: an unpriceable business gets no Stripe customer, no list and no session", async () => {
    const h = make({ unpriced: true, noCustomer: true });
    await expect(h.billing.createCheckoutSession("t1", admin)).rejects.toThrow("no price");
    expect(h.stripe.createCustomer).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("L15: a Stripe list failure is a coded 503 and creates nothing", async () => {
    const h = make();
    h.list.mockRejectedValueOnce(new Error("stripe down"));
    await expect(h.billing.createCheckoutSession("t1", admin)).rejects.toMatchObject({
      status: 503,
      response: { code: API_ERROR_CODES.CHECKOUT_SLOT_UNAVAILABLE },
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("L15: a lock timeout is the same coded 503 and creates nothing", async () => {
    const h = make();
    locked.fail = new LockTimeoutError("tenant-price", "t1", 20_000);
    await expect(h.billing.createCheckoutSession("t1", admin)).rejects.toMatchObject({
      status: 503,
      response: { code: API_ERROR_CODES.CHECKOUT_SLOT_UNAVAILABLE },
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("L16: a complete session the webhook has not applied is 'Payment in progress', never a new session", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", admin);
    h.sessions[0].status = "complete";
    h.sessions[0].subscription = "sub_paid";
    await expect(h.billing.createCheckoutSession("t1", admin)).rejects.toMatchObject({
      status: 409,
      response: { code: API_ERROR_CODES.CHECKOUT_PAYMENT_IN_PROGRESS },
    });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("L17: cancel, then create again inside 24 h gives a NEW payable link (not the replayed dead one)", async () => {
    const h = make();
    const first: any = await h.billing.createCheckoutSession("t1", admin);
    await h.billing.cancelOpenLink("t1");
    const again: any = await h.billing.createCheckoutSession("t1", admin);
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(h.sessions.find((s) => s.id === again.sessionId).status).toBe("open");
  });

  it("L3: after a reload the open link is shown again and no new session is made", async () => {
    const h = make();
    const made: any = await h.billing.createCheckoutSession("t1", admin);
    const reloaded = make({ stripeState: h.fake }); // a fresh service over the same Stripe state
    const link = await reloaded.billing.getOpenLink("t1");
    expect(link).toEqual({
      kind: "card",
      url: made.checkoutUrl,
      expiresAt: new Date(h.sessions[0].expires_at * 1000).toISOString(),
    });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("L4: another business's session on the same Stripe customer is never returned", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", admin);
    const other = make({ stripeState: h.fake, tenantId: "t2" });
    expect(await other.billing.getOpenLink("t2")).toBeNull();
  });

  it("L9: a card-billed business (live Stripe subscription) gets no list and no session", async () => {
    const h = make({ sub: { stripeSubId: "sub_live" } });
    h.stripe.getSubscription.mockResolvedValue({ status: "active" });
    await expect(h.billing.createCheckoutSession("t1", admin)).rejects.toThrow(/already has/);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("L12: the URL is never logged and no column is written", async () => {
    const spies = (["log", "warn", "error", "debug"] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    const h = make();
    const made: any = await h.billing.createCheckoutSession("t1", admin);
    await h.billing.getOpenLink("t1");
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0])));
    expect(logged.some((l) => l.includes(made.checkoutUrl))).toBe(false);
    expect(h.prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });

  it("L24: managed payments stays OFF on a new session", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", admin);
    expect(h.create.mock.calls[0][0].managed_payments).toEqual({ enabled: false });
  });

  it("cancel expires the open session and the card section is empty again", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", admin);
    await h.billing.cancelOpenLink("t1");
    expect(h.expire).toHaveBeenCalledWith("cs_1");
    expect(await h.billing.getOpenLink("t1")).toBeNull();
  });
});
