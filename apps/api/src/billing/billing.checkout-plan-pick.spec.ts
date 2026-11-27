import { BadRequestException, ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { webBaseUrl } from "../config/web-base-url";
import { pinWallClock } from "../testing/pin-clock";
import {
  API_BILLING_CANCEL_PATH,
  API_BILLING_RETURN_PATHS,
  billingReturnUrl,
} from "./billing-return-paths";
import { BillingService } from "./billing.service";
import { openCheckoutSession, openCheckoutSessionHeld } from "./open-checkout-session";
import { SubscriptionMutationService } from "./subscription-mutation.service";

/**
 * SA-1547 PR-5 (card-first chunk 2, API): a `{ planKey }` pick on the one checkout path. R8 (the session bills the
 * PICKED plan), R9 (a re-pin alone is not a conversion), R10 (one tenant-price hold, never nested), R11 (the wall
 * before any write), R12 (a quoted fee), R13 (a TRIAL pick stays TRIAL). Stripe, Prisma and the lock are fakes.
 */
interface Lock {
  family: string;
  waitMs?: number;
  depthAtAcquire: number;
}
const locks: Lock[] = [];
let depth = 0;
/** What happened, in order: a spy on the order of the refusals, the pin and the session. */
const log: string[] = [];
jest.mock("../common/db-locks", () => {
  const actual = jest.requireActual("../common/db-locks");
  return {
    ...actual,
    withAdvisoryLock: async (
      o: { family: string; key: string; waitMs?: number },
      fn: () => Promise<unknown>,
    ) => {
      locks.push({ family: o.family, waitMs: o.waitMs, depthAtAcquire: depth });
      if (o.family === "tenant-price") log.push("lock");
      depth += 1;
      try {
        return { acquired: true, value: await fn() };
      } finally {
        depth -= 1;
      }
    },
  };
});

const PRICE: Record<string, number> = { STARTER: 99, CORE: 199, GROWTH: 299 };
const def = (planKey: string, monthlyPrice: number, extra: Record<string, unknown> = {}) => ({
  planKey,
  name: planKey,
  monthlyPrice,
  isCustom: false,
  ...extra,
});
const VERSION = {
  id: "v14",
  definitions: [
    def("LITE", 49),
    def("STARTER", 99),
    def("CORE", 199),
    def("ENTERPRISE", 0, { isCustom: true }),
  ],
  addonSkus: [],
} as any;

function fakeStripe() {
  const sessions: any[] = [];
  const create = jest.fn(async (params: any) => {
    log.push("session");
    const s = {
      id: `cs_${sessions.length + 1}`,
      url: `https://pay.test/${sessions.length + 1}`,
      status: "open",
      customer: params.customer,
      metadata: params.metadata,
      expires_at: params.expires_at,
      created: Math.floor(Date.now() / 1000),
      subscription: null,
    };
    sessions.unshift(s);
    return s;
  });
  const list = jest.fn(async () => {
    log.push("slot");
    return { data: sessions, has_more: false };
  });
  const expire = jest.fn(async (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (s) s.status = "expired";
    return s;
  });
  const stripe: any = {
    isConfigured: true,
    client: { checkout: { sessions: { create, list, expire } } },
    getSubscription: jest.fn(),
    createCustomer: jest.fn(async () => ({ id: "cus_1" })),
  };
  return { stripe, sessions, create, list, expire };
}

function make(
  o: {
    planKey?: string;
    override?: number | null;
    tenantClass?: string;
    status?: string;
    readOnlyReason?: string | null;
    trialEndsAt?: Date | null;
    noCustomer?: boolean;
    sub?: Record<string, unknown>;
    /** A pricing resolver that ignores the pin (a bug the readOffer assertion must catch). */
    stuckPricing?: string;
    /** The class the wall reads the SECOND time (inside the hold). */
    holdClass?: string;
  } = {},
) {
  const state = {
    planKey: o.planKey ?? "STARTER",
    base: PRICE[o.planKey ?? "STARTER"],
    pinned: "v13" as string | null,
    override: o.override ?? null,
  };
  const writes: any[] = [];
  let wallReads = 0;
  const stripeFake = fakeStripe();
  const tx: any = {
    $queryRaw: jest.fn(async () => []),
    tenant: {
      findUnique: jest.fn(async () => ({ plan: state.planKey })),
      updateMany: jest.fn(async (a: any) => {
        writes.push(["tenant.updateMany", a.data]);
        return { count: 1 };
      }),
    },
    tenantSubscription: {
      findUnique: jest.fn(async () => ({
        planKey: state.planKey,
        priceOverrideMonthly: state.override,
      })),
      upsert: jest.fn(async (a: any) => {
        log.push("repin");
        writes.push(["sub.upsert", a.update]);
        state.planKey = a.update.planKey;
        state.base = Number(a.update.basePriceSnapshot);
        return {};
      }),
      updateMany: jest.fn(async (a: any) => {
        writes.push(["sub.updateMany", a.data]);
        state.pinned = a.data.planVersionId ?? state.pinned;
        return { count: 1 };
      }),
    },
  };
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async (a: any) => {
        if (a?.select?.class === true && Object.keys(a.select).length === 1) {
          log.push("wall");
          wallReads += 1;
          return {
            class: wallReads > 1 && o.holdClass ? o.holdClass : (o.tenantClass ?? "PRODUCTION"),
          };
        }
        return {
          id: "t1",
          slug: "acme",
          class: o.tenantClass ?? "PRODUCTION",
          status: o.status ?? "READ_ONLY",
          readOnlyReason: o.readOnlyReason === undefined ? "trial_expired" : o.readOnlyReason,
          trialEndsAt: o.trialEndsAt ?? null,
          subscription: o.noCustomer ? null : { stripeCustomerId: "cus_1" },
          config: { businessName: "Acme" },
        };
      }),
    },
    user: { findMany: jest.fn(async () => []) },
    tenantSubscription: {
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({
        stripeCustomerId: o.noCustomer ? null : "cus_1",
        stripeSubId: null,
        externalPayment: false,
        catchupState: null,
        catchupSessionId: null,
        ...o.sub,
      })),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => ({ planKey: o.stuckPricing ?? state.planKey })),
    checkoutPriceData: jest.fn(async (_t: string, interval: string) => ({
      currency: "usd",
      product_data: { name: state.planKey },
      unit_amount: Math.round((state.override ?? PRICE[state.planKey]) * 100),
      recurring: { interval },
    })),
  };
  const mutations: any = { checkoutAddonLines: jest.fn(async () => ({ lineItems: [], skus: [] })) };
  const events = { emit: jest.fn() };
  const catalog = { getPublishedCatalog: jest.fn(async () => VERSION) };
  const billing = new BillingService(
    prisma,
    stripeFake.stripe,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    events as any,
    pricing,
    {} as any,
    {} as any,
    mutations,
    undefined,
    undefined,
    undefined,
    undefined,
    catalog as any,
  );
  return { billing, prisma, tx, state, writes, events, ...stripeFake };
}

const self = { surface: "TENANT_SELF" as const };
const pick = (planKey: string, verdict: "SESSION" | "TRIAL_PICK" = "SESSION") => {
  const gate = jest.fn(async () => {
    log.push("gate");
    return verdict;
  });
  return { gate, opts: { ...self, pick: { planKey, gate } } };
};
const rejection = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => undefined,
    (e) => e,
  );

beforeEach(() => {
  pinWallClock();
  locks.length = 0;
  log.length = 0;
  depth = 0;
});
afterEach(() => jest.useRealTimers());

describe("R8: a trial-expired business on STARTER picks CORE", () => {
  it("the session bills CORE's amount and key, and the snapshot after the re-pin is CORE's price", async () => {
    const h = make();
    const out: any = await h.billing.createCheckoutSession("t1", pick("CORE").opts);
    expect(h.create).toHaveBeenCalledTimes(1);
    const body = h.create.mock.calls[0][0] as any;
    expect(body.line_items[0].price_data.unit_amount).toBe(19900);
    expect(body.metadata.planKey).toBe("CORE");
    expect(out).toMatchObject({ kind: "SESSION", uiMode: "hosted" });
    expect(out.checkoutUrl).toContain("https://pay.test/");
    expect(h.state).toMatchObject({ planKey: "CORE", base: 199, pinned: "v14" });
  });

  it("a request with no pick is unchanged: STARTER's own terms, no kind, no re-pin, no transaction", async () => {
    const h = make();
    const out: any = await h.billing.createCheckoutSession("t1", self);
    expect((h.create.mock.calls[0][0] as any).metadata.planKey).toBe("STARTER");
    expect(out.kind).toBeUndefined();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.state.planKey).toBe("STARTER");
  });

  it("the pick is the same plan as now: a no-op re-pin, and the session still opens", async () => {
    const h = make();
    const out: any = await h.billing.createCheckoutSession("t1", pick("STARTER").opts);
    expect(out.kind).toBe("SESSION");
    expect(h.writes).toEqual([]);
    expect(h.state).toMatchObject({ planKey: "STARTER", pinned: "v13" });
  });
});

describe("the add-on rule the re-pin relies on (R8): an add-on the PINNED plan includes is not billed", () => {
  function realLines(planKey: string) {
    const catalogDef = {
      definitions: [def("STARTER", 99), def("CORE", 199)],
      addonSkus: [
        { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 19, includedAtPlan: "CORE" },
      ],
    };
    const row = {
      id: "a1",
      addonKey: "FORECASTING",
      sku: "FORECASTING",
      active: true,
      quantity: 1,
      priceSnapshot: 0,
      stripeItemId: null,
      isComp: false,
      createdAt: new Date(1_790_000_000_000),
    };
    const prisma: any = {
      tenantAddon: { findMany: jest.fn(async () => [row]) },
      tenant: { findUnique: jest.fn(async () => ({ plan: "STARTER", planVersionId: null })) },
      tenantSubscription: {
        findUnique: jest.fn(async () => ({ planKey, planVersionId: null })),
      },
    };
    const cat = {
      getPublishedCatalog: jest.fn(async () => catalogDef),
      getVersionForTenant: jest.fn(async () => catalogDef),
    };
    const svc = new SubscriptionMutationService(
      prisma,
      cat as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { isConfigured: true, client: {} } as any,
      {} as any,
      {} as any,
    );
    return svc.checkoutAddonLines("t1", "month", { readOnly: true });
  }

  it("on STARTER the SKU is billed; once the plan is CORE it gets no line", async () => {
    expect((await realLines("STARTER")).skus).toEqual(["FORECASTING"]);
    expect((await realLines("CORE")).skus).toEqual([]);
  });
});

describe("R9: the re-pin, then the customer cancels on Stripe", () => {
  it("the plan stays re-pinned and nothing else is written: no status, no conversion, no ledger, no alert", async () => {
    const h = make();
    const out: any = await h.billing.createCheckoutSession("t1", pick("CORE").opts);
    await h.stripe.client.checkout.sessions.expire(out.sessionId); // Cancel on Stripe: nothing completes
    expect(h.state).toMatchObject({ planKey: "CORE", base: 199 });
    expect(h.writes).toEqual([
      ["sub.upsert", { planKey: "CORE", currentPlan: "CORE", basePriceSnapshot: 199 }],
      ["sub.updateMany", { planVersionId: "v14" }],
      ["tenant.updateMany", { planVersionId: "v14" }],
    ]);
    expect(JSON.stringify(h.writes)).not.toMatch(/trialConvertedAt|status|TRIAL_CONVERTED/);
    expect(h.events.emit).not.toHaveBeenCalled();
    expect((h.prisma.tenant as any).update).toBeUndefined();
  });
});

describe("R10 / R3: ONE tenant-price hold, refusals first, the pin, then the session", () => {
  it("one acquisition for the request, never taken while held, on the short self-serve wait", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", pick("CORE").opts);
    const price = locks.filter((l) => l.family === "tenant-price");
    expect(price).toHaveLength(1);
    expect(price[0].depthAtAcquire).toBe(0);
    expect(price[0].waitMs).toBe(2_500);
  });

  it("inside the hold the order is: wall, eligibility gate, the open-session check, re-pin, then the Stripe session", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", pick("CORE").opts);
    const inHold = log.slice(log.indexOf("lock") + 1);
    expect(inHold.slice(0, 3)).toEqual(["wall", "gate", "slot"]);
    expect(inHold.indexOf("slot")).toBeLessThan(inHold.indexOf("repin"));
    expect(inHold.indexOf("repin")).toBeLessThan(inHold.lastIndexOf("slot"));
    expect(inHold.lastIndexOf("slot")).toBeLessThan(inHold.indexOf("session"));
  });

  it("a paid session the webhook has not applied refuses BEFORE the re-pin (completion prices from the pin)", async () => {
    const h = make();
    h.sessions.push({
      id: "cs_paid",
      status: "complete",
      customer: "cus_1",
      metadata: { tenantId: "t1" },
      created: Math.floor(Date.now() / 1000),
      subscription: "sub_new",
    });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("CORE").opts));
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.CHECKOUT_PAYMENT_IN_PROGRESS });
    expect(h.state.planKey).toBe("STARTER");
    expect(h.writes).toEqual([]);
  });

  it("an open session at the old plan is closed before the re-pin, and a new one bills the picked plan", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", self);
    await h.billing.createCheckoutSession("t1", pick("CORE").opts);
    expect(h.expire).toHaveBeenCalledWith("cs_1");
    expect(h.sessions.filter((s) => s.status === "open")).toHaveLength(1);
    expect((h.create.mock.calls[1][0] as any).metadata.planKey).toBe("CORE");
  });

  it("the refusals run again inside the hold: a live Stripe subscription found there refuses before the re-pin", async () => {
    const h = make({ sub: { stripeSubId: "sub_live" } });
    h.stripe.getSubscription.mockResolvedValue({ status: "active" });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("CORE").opts));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(h.state.planKey).toBe("STARTER");
    expect(h.create).not.toHaveBeenCalled();
  });

  it("a manual-pay business is refused with the catch-up code before any re-pin", async () => {
    const h = make({ sub: { externalPayment: true } });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("CORE").opts));
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP });
    expect(h.state.planKey).toBe("STARTER");
  });

  it("openCheckoutSessionHeld takes no lock of its own; openCheckoutSession takes exactly one", async () => {
    const h = make();
    const d = { prisma: h.prisma, stripe: h.stripe };
    const offer = async () => ({
      terms: {
        planKey: "STARTER",
        unitAmount: 9900,
        addonSkus: [],
        addonLines: [],
        anchorAt: new Date("2026-12-01T12:00:00Z"),
      },
      params: {
        customer: "cus_1",
        mode: "subscription",
        line_items: [],
        success_url: billingReturnUrl(webBaseUrl(), API_BILLING_RETURN_PATHS.plan),
        cancel_url: billingReturnUrl(webBaseUrl(), API_BILLING_CANCEL_PATH),
        metadata: { tenantId: "t1" },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      } as any,
    });
    const a = {
      tenantId: "t1",
      customerId: "cus_1",
      surface: "TENANT_SELF" as const,
      readOffer: offer,
    };
    await openCheckoutSessionHeld(d, a);
    expect(locks).toHaveLength(0);
    await openCheckoutSession(d, a);
    expect(locks).toHaveLength(1);
  });
});

describe("R11: the #4552 wall runs before any write", () => {
  it("a non-PRODUCTION business with a pick is refused LIVE_PAYMENTS_OFF and is not re-pinned", async () => {
    const h = make({ tenantClass: "TEST" });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("CORE").opts));
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.LIVE_PAYMENTS_OFF });
    expect(h.state.planKey).toBe("STARTER");
    expect(h.writes).toEqual([]);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("a class that turns non-PRODUCTION while the request waits is caught by the wall inside the hold", async () => {
    const h = make({ holdClass: "TEST" });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("CORE").opts));
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.LIVE_PAYMENTS_OFF });
    expect(log).toContain("lock");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
});

describe("R7 through the service: a key the published catalog does not offer", () => {
  it.each(["LITE", "ENTERPRISE", "NOPE"])(
    "%s is a coded 400, no re-pin and no session",
    async (k) => {
      const h = make();
      const err = await rejection(h.billing.createCheckoutSession("t1", pick(k).opts));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED,
      });
      expect(h.writes).toEqual([]);
      expect(h.create).not.toHaveBeenCalled();
    },
  );
});

describe("R12: a business with a quoted fee", () => {
  it("picking another plan is a coded 409: no re-pin and no session", async () => {
    const h = make({ override: 150 });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("CORE").opts));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED });
    expect(h.writes).toEqual([]);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("picking the plan it is on pays the quoted fee", async () => {
    const h = make({ override: 150 });
    const out: any = await h.billing.createCheckoutSession("t1", pick("STARTER").opts);
    expect(out.kind).toBe("SESSION");
    expect((h.create.mock.calls[0][0] as any).line_items[0].price_data.unit_amount).toBe(15000);
  });
});

describe("R13: a TRIAL business picks a plan (the gate says TRIAL_PICK)", () => {
  it("re-pins and stays TRIAL: no session, no Stripe call, no status change; the answer says what the web needs", async () => {
    const trialEndsAt = new Date("2026-12-09T00:00:00.000Z");
    const h = make({ status: "TRIAL", readOnlyReason: null, trialEndsAt, noCustomer: true });
    const out: any = await h.billing.createCheckoutSession("t1", pick("CORE", "TRIAL_PICK").opts);
    expect(out).toEqual({
      kind: "TRIAL_PLAN_SET",
      planKey: "CORE",
      planName: "Essentials",
      trialEndsAt: "2026-12-09T00:00:00.000Z",
    });
    expect(h.state).toMatchObject({ planKey: "CORE", base: 199, pinned: "v14" });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.stripe.createCustomer).not.toHaveBeenCalled();
    expect(JSON.stringify(h.writes)).not.toMatch(/status|trialConvertedAt/);
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

describe("R5 / ruling 5: the offer read under the lock must show the pinned plan", () => {
  it("a read that shows another plan is a coded 409 and no session is made", async () => {
    const h = make({ stuckPricing: "STARTER" });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("CORE").opts));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED });
    expect(h.create).not.toHaveBeenCalled();
  });
});
