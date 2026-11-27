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
import { openCheckoutSession } from "./open-checkout-session";
import { PlanCatalogService } from "./plan-catalog.service";

/**
 * SA-1547 PR-5 (SA-1319 R1 / R1a): a `{ planKey }` pick on the one checkout path WRITES NOTHING. The plan, its catalog
 * version and its quoted price ride on the session's metadata and terms hash; the paid completion applies them (its own
 * specs are in billing.service.spec.ts). Stripe, Prisma and the lock are fakes; the Prisma fake has no write for a plan, a
 * tenant or a pin, so any such write is a TypeError.
 */
interface Lock {
  family: string;
  waitMs?: number;
  depthAtAcquire: number;
}
const locks: Lock[] = [];
let depth = 0;
/** What happened, in order: a spy on the order of the refusals and the session. */
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

const PRICE: Record<string, number> = { STARTER: 99, CORE: 199, GROWTH: 299, ALL_IN: 349 };
const def = (planKey: string, monthlyPrice: number, extra: Record<string, unknown> = {}) => ({
  planKey,
  name: planKey,
  monthlyPrice,
  isCustom: false,
  ...extra,
});
const PUBLISHED = {
  id: "v14",
  definitions: [
    def("LITE", 49),
    def("STARTER", 99),
    def("CORE", 199),
    def("GROWTH", 299),
    def("ALL_IN", 349),
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
  const list = jest.fn(async () => ({ data: sessions, has_more: false }));
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
    /** The version the business is pinned to, and the price that version holds for its plan (a locked price). */
    pinnedVersionId?: string;
    lockedMonthly?: number;
    override?: number | null;
    tenantClass?: string;
    status?: string;
    readOnlyReason?: string | null;
    sub?: Record<string, unknown>;
  } = {},
) {
  const planKey = o.planKey ?? "STARTER";
  const stripeFake = fakeStripe();
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async (a: any) => {
        if (a?.select?.class === true && Object.keys(a.select).length === 1) {
          log.push("wall");
          return { class: o.tenantClass ?? "PRODUCTION" };
        }
        return {
          id: "t1",
          slug: "acme",
          class: o.tenantClass ?? "PRODUCTION",
          status: o.status ?? "READ_ONLY",
          readOnlyReason: o.readOnlyReason === undefined ? "trial_expired" : o.readOnlyReason,
          plan: planKey,
          planVersionId: o.pinnedVersionId ?? null,
          subscription: {
            planKey,
            planVersionId: o.pinnedVersionId ?? null,
            priceOverrideMonthly: o.override ?? null,
            stripeCustomerId: "cus_1",
          },
          config: { businessName: "Acme" },
        };
      }),
    },
    user: { findMany: jest.fn(async () => []) },
    tenantSubscription: {
      upsert: jest.fn(async () => ({})), // ensureStripeCustomer's only write
      findUnique: jest.fn(async () => ({
        stripeCustomerId: "cus_1",
        stripeSubId: null,
        externalPayment: false,
        catchupState: null,
        catchupSessionId: null,
        ...o.sub,
      })),
    },
  };
  const pricing: any = {
    // the plan the business is ON, from its pin (a locked price is honoured)
    resolveTenantPricing: jest.fn(async () => ({
      planKey,
      planName: planKey,
      monthly: o.override ?? o.lockedMonthly ?? PRICE[planKey],
    })),
    // `opts.plan` is a plan the business is PICKING (its published price); otherwise the plan it is on, from its pin
    checkoutPriceData: jest.fn(
      async (
        _t: string,
        interval: string,
        _p?: unknown,
        opts?: { plan?: { monthly: number } },
      ) => ({
        currency: "usd",
        product: "prod_x",
        unit_amount: Math.round(
          (opts?.plan?.monthly ?? o.override ?? o.lockedMonthly ?? PRICE[planKey]) * 100,
        ),
        recurring: { interval },
      }),
    ),
  };
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => ({ lineItems: [], skus: [] })),
    invalidatePlanCaches: jest.fn(),
  };
  const events = { emit: jest.fn() };
  const catalog = {
    getPublishedCatalog: jest.fn(async () => PUBLISHED),
    getVersionForTenant: jest.fn(async (id: string | null) => ({
      ...PUBLISHED,
      id: id ?? PUBLISHED.id,
    })),
  };
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
  return { billing, prisma, pricing, mutations, events, catalog, ...stripeFake };
}

const self = { surface: "TENANT_SELF" as const };
const pick = (planKey: string) => {
  const gate = jest.fn(async () => {
    log.push("gate");
  });
  return { gate, opts: { ...self, pick: { planKey, gate } } };
};
const rejection = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => undefined,
    (e) => e,
  );
const meta = (h: ReturnType<typeof make>, i = 0) => (h.create.mock.calls[i][0] as any).metadata;

beforeEach(() => {
  pinWallClock();
  locks.length = 0;
  log.length = 0;
  depth = 0;
});
afterEach(() => jest.useRealTimers());

describe("R1a 7 / 10: a trial-expired business picks another plan; nothing is written", () => {
  it("the session bills the PICKED plan's published price and carries its terms; no write, no event", async () => {
    const h = make();
    const out: any = await h.billing.createCheckoutSession("t1", pick("GROWTH").opts);
    expect(out).toMatchObject({ uiMode: "hosted" });
    expect(out.kind).toBeUndefined(); // the response shape is today's
    const body = h.create.mock.calls[0][0] as any;
    expect(body.line_items[0].price_data.unit_amount).toBe(29900);
    expect(meta(h)).toMatchObject({
      planKey: "GROWTH",
      selfPick: "1",
      planVersionId: "v14",
      quotedMonthly: "299",
    });
    // the add-ons are judged on the PICKED plan (a SKU it includes is not billed)
    expect(h.mutations.checkoutAddonLines).toHaveBeenLastCalledWith("t1", "month", {
      asPlanKey: "GROWTH",
    });
    // R10: cancel on Stripe = nothing happened. The only write the fake allows is the Stripe customer's own upsert.
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.prisma.tenant.update).toBeUndefined();
    expect(h.prisma.tenantSubscription.update).toBeUndefined();
    expect(h.prisma.$transaction).toBeUndefined();
    // M2: no subscription upsert (ensureStripeCustomer's is skipped: the customer exists) and no cache dropped at pick time
    expect(h.prisma.tenantSubscription.upsert).not.toHaveBeenCalled();
    expect(h.mutations.invalidatePlanCaches).not.toHaveBeenCalled();
  });

  it("a request with no pick is today's: the pinned plan, no pick metadata, no pick read", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", self);
    expect(meta(h)).not.toHaveProperty("selfPick");
    expect(meta(h).planKey).toBe("STARTER");
    expect(h.catalog.getPublishedCatalog).not.toHaveBeenCalled();
  });
});

describe("R1 3 / 4: the one slot", () => {
  it("pick Growth, then Essentials: the first session is expired and only one is open", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", pick("GROWTH").opts);
    await h.billing.createCheckoutSession("t1", pick("CORE").opts);
    expect(h.expire).toHaveBeenCalledWith("cs_1");
    expect(h.sessions.filter((s) => s.status === "open")).toHaveLength(1);
    expect(meta(h, 1).planKey).toBe("CORE");
  });

  it("the same plan clicked twice reuses ONE session (cs_1, not cs_2)", async () => {
    const h = make();
    const a: any = await h.billing.createCheckoutSession("t1", pick("GROWTH").opts);
    const b: any = await h.billing.createCheckoutSession("t1", pick("GROWTH").opts);
    expect(b.sessionId).toBe(a.sessionId);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.expire).not.toHaveBeenCalled();
  });

  it("a refused pick leaves an OPEN session alone (whitelist, LITE, quoted fee)", async () => {
    for (const [k, o] of [
      ["LITE", {}],
      ["NOPE", {}],
      ["CORE", { override: 150 }],
    ] as const) {
      log.length = 0;
      const h = make(o);
      await h.billing.createCheckoutSession("t1", self); // an open session at the pinned plan
      const err = await rejection(h.billing.createCheckoutSession("t1", pick(k).opts));
      expect(err).toBeDefined();
      expect(h.expire).not.toHaveBeenCalled();
      expect(h.sessions.filter((s) => s.status === "open")).toHaveLength(1);
    }
  });
});

describe("R1a 9: a business pinned at a locked price picks its own plan", () => {
  it("the quoted price and version are the PINNED ones, not the published ones", async () => {
    const h = make({ planKey: "CORE", pinnedVersionId: "v9", lockedMonthly: 79 });
    await h.billing.createCheckoutSession("t1", pick("CORE").opts);
    expect((h.create.mock.calls[0][0] as any).line_items[0].price_data.unit_amount).toBe(7900);
    expect(meta(h)).toMatchObject({ planVersionId: "v9", quotedMonthly: "79", selfPick: "1" });
    expect(h.pricing.checkoutPriceData).toHaveBeenLastCalledWith("t1", "month"); // the pinned plan's price path
    expect(h.mutations.checkoutAddonLines).toHaveBeenLastCalledWith("t1", "month", {});
  });
});

describe("R1 trial pick: a TRIAL business that picks pays now", () => {
  it("opens the session through the normal path; the trial is not touched", async () => {
    const h = make({ planKey: "ALL_IN", status: "TRIAL", readOnlyReason: null });
    const out: any = await h.billing.createCheckoutSession("t1", pick("CORE").opts);
    expect(out.uiMode).toBe("hosted");
    expect(meta(h)).toMatchObject({ planKey: "CORE", selfPick: "1", planVersionId: "v14" });
    expect(h.prisma.tenant.update).toBeUndefined();
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

describe("R6 / R7: what a pick may name", () => {
  it.each(["LITE", "ENTERPRISE", "NOPE"])(
    "%s is a coded 400: no session, nothing written",
    async (k) => {
      const h = make();
      const err = await rejection(h.billing.createCheckoutSession("t1", pick(k).opts));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED,
      });
      expect(h.create).not.toHaveBeenCalled();
    },
  );

  it("R6: an invited LITE business sending {planKey: STARTER} is a coded 400", async () => {
    const h = make({ planKey: "LITE" });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("STARTER").opts));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.SELF_SERVE_PLAN_NOT_ALLOWED });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("R12: a business with a quoted fee picking another plan is a coded 409; its own plan pays the fee", async () => {
    const h = make({ override: 150 });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("CORE").opts));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.CUSTOM_FEE_PLAN_PICK_REFUSED });
    expect(h.create).not.toHaveBeenCalled();
    await h.billing.createCheckoutSession("t1", pick("STARTER").opts);
    expect((h.create.mock.calls[0][0] as any).line_items[0].price_data.unit_amount).toBe(15000);
  });

  it("a pick session that lacks its plan version is refused BEFORE anything is expired or created", async () => {
    const h = make();
    const d = { prisma: h.prisma, stripe: h.stripe };
    const offer = async () => ({
      terms: {
        planKey: "CORE",
        unitAmount: 19900,
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
        metadata: { tenantId: "t1", planKey: "CORE", selfPick: "1" },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      } as any,
    });
    const err = await rejection(
      openCheckoutSession(d, {
        tenantId: "t1",
        customerId: "cus_1",
        surface: "TENANT_SELF",
        readOffer: offer,
      }),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.expire).not.toHaveBeenCalled();
  });
});

describe("R10 / R11: one hold, the wall first", () => {
  it("one tenant-price acquisition, never taken while held, on the short self-serve wait", async () => {
    const h = make();
    await h.billing.createCheckoutSession("t1", pick("GROWTH").opts);
    const price = locks.filter((l) => l.family === "tenant-price");
    expect(price).toHaveLength(1);
    expect(price[0].depthAtAcquire).toBe(0);
    expect(price[0].waitMs).toBe(2_500);
  });

  it("inside the hold: the wall, then the eligibility gate (ONCE per click), then the session", async () => {
    const h = make();
    const p = pick("GROWTH");
    await h.billing.createCheckoutSession("t1", p.opts);
    expect(p.gate).toHaveBeenCalledTimes(1);
    const inHold = log.slice(log.indexOf("lock") + 1);
    expect(inHold.slice(0, 2)).toEqual(["wall", "gate"]);
    expect(inHold.indexOf("gate")).toBeLessThan(inHold.indexOf("session"));
  });

  it("R11: a non-PRODUCTION business with a pick is refused LIVE_PAYMENTS_OFF, before anything else", async () => {
    const h = make({ tenantClass: "TEST" });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("GROWTH").opts));
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.LIVE_PAYMENTS_OFF });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.catalog.getPublishedCatalog).not.toHaveBeenCalled();
    expect(log.indexOf("wall")).toBeGreaterThan(log.indexOf("lock")); // the wall is the first read inside the hold
    expect(log).not.toContain("gate"); // and the gate never ran
  });

  it("the refusals run again inside the hold: a manual-pay business is refused before any session", async () => {
    const h = make({ sub: { externalPayment: true } });
    const err = await rejection(h.billing.createCheckoutSession("t1", pick("GROWTH").opts));
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP });
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe("DI: the plan catalog is a required provider", () => {
  it("is not @Optional, and is the PlanCatalogService", () => {
    const optional: number[] = Reflect.getMetadata("optional:paramtypes", BillingService) ?? [];
    const types = Reflect.getMetadata("design:paramtypes", BillingService);
    const i = types.indexOf(PlanCatalogService);
    expect(i).toBeGreaterThan(-1);
    expect(optional).not.toContain(i);
  });
});
