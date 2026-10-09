import { buildCatchupSessionParams, assertCheckoutAcceptable } from "./catchup-session-params";
import { planCatchup, type CatchupInvoice } from "./catchup-plan";
import { CATCHUP_META } from "./catchup-claim";

/**
 * SA-733r5 against Stripe's DOCUMENTED Checkout limits (docs.stripe.com/payments/checkout/billing-cycle,
 * "Limitations"): no trial with a billing cycle anchor, no one-time price with proration_behavior. The session
 * params are a pure function of the plan, ONE builder per shape, so the whole matrix is asserted with no Stripe.
 */
const d = (iso: string) => new Date(iso);
const inv = (id: string, status: string, start: string, end: string): CatchupInvoice => ({
  id,
  status,
  periodStart: d(start),
  periodEnd: d(end),
});
const NOW = d("2026-10-09T10:00:00Z");
const PLAN_LINE = {
  currency: "usd",
  unit_amount: 31000,
  recurring: { interval: "month" },
  product_data: { name: "RouteFlow Growth — monthly" },
};
const ADDON_LINE = {
  price_data: {
    currency: "usd",
    unit_amount: 3100,
    recurring: { interval: "month" },
    product_data: { name: "RouteFlow add-on — Forecasting", metadata: { addonSku: "FORECASTING" } },
  },
  quantity: 1,
};

function plan(over: { now?: Date; invoices?: CatchupInvoice[]; addon?: boolean } = {}) {
  const p = planCatchup({
    now: over.now ?? NOW,
    monthly: 310,
    addons: over.addon ? [{ sku: "FORECASTING", unitPrice: 31, quantity: 1 }] : [],
    invoices: over.invoices ?? [],
  });
  if (!p.ok) throw new Error(p.reason);
  return p;
}
const build = (p: ReturnType<typeof plan>, now = NOW, addon = false) =>
  buildCatchupSessionParams({
    tenantId: "t1",
    slug: "acme",
    planKey: "GROWTH",
    customerId: "cus_1",
    planPriceData: PLAN_LINE,
    addonLines: addon ? [ADDON_LINE] : [],
    addonSkus: addon ? ["FORECASTING"] : [],
    plan: p,
    now,
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
  });
const isOneTime = (li: any) => !li.price_data.recurring;

describe("trial_one_time (the common case: an unpaid October, session Oct 9)", () => {
  const p = plan({ addon: true });
  const params = build(p, NOW, true);

  it("trial_end = A (Nov 1 12:00Z) ALONE: no billing_cycle_anchor, no proration_behavior", () => {
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.subscription_data).not.toHaveProperty("billing_cycle_anchor");
    expect(params.subscription_data).not.toHaveProperty("proration_behavior");
    expect(params.mode).toBe("subscription");
    expect(params.payment_method_collection).toBe("always");
  });

  it("lines: the recurring plan + add-on items, plus exactly ONE one-time line = the unpaid October incl. add-ons", () => {
    const oneTime = params.line_items.filter(isOneTime);
    expect(oneTime).toHaveLength(1);
    expect(oneTime[0]).toEqual({
      price_data: {
        currency: "usd",
        unit_amount: 31000 + 3100, // base 31/31 + add-on 31/31
        product_data: { name: "Subscription — October 2026" },
      },
      quantity: 1,
    });
    expect(params.line_items.filter((l: any) => !isOneTime(l))).toHaveLength(2);
  });

  it("metadata: catchup=period plus from/to on the session AND the subscription", () => {
    expect(params.metadata).toMatchObject({
      tenantId: "t1",
      planKey: "GROWTH",
      interval: "month",
      addonSkus: "FORECASTING",
      [CATCHUP_META.catchup]: "period",
      [CATCHUP_META.shape]: "trial_one_time",
      [CATCHUP_META.stubCents]: "34100",
      [CATCHUP_META.from]: "2026-10-01T12:00:00.000Z",
      [CATCHUP_META.to]: "2026-11-01T12:00:00.000Z",
    });
    expect(params.subscription_data.metadata).toMatchObject({
      tenantId: "t1",
      catchup: "period",
      catchup_from: "2026-10-01T12:00:00.000Z",
      catchup_to: "2026-11-01T12:00:00.000Z",
    });
  });

  it("the session lives min(now + 24 h, A - 60 min) = 24 h", () => {
    expect(params.expires_at).toBe(Math.floor((NOW.getTime() + 24 * 3600_000) / 1000));
  });

  it("session Oct 30: A = Dec 1, ONE line for Oct 1 -> Nov 30 (two months)", () => {
    const now = d("2026-10-30T12:00:00Z");
    const q = plan({ now });
    const x = build(q, now);
    expect(x.subscription_data.trial_end).toBe(Date.UTC(2026, 11, 1, 12) / 1000);
    expect(x.line_items.filter(isOneTime)[0].price_data.unit_amount).toBe(62000);
    expect(x.line_items.filter(isOneTime)[0].price_data.product_data.name).toBe(
      "Subscription — October 2026 to November 2026",
    );
  });

  it("a stub under Stripe's $0.50 minimum sends no one-time line at all", () => {
    const now = d("2026-10-10T12:00:00Z");
    const q = planCatchup({
      now,
      monthly: 0.1,
      addons: [],
      invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-10-20T12:00:00Z")],
    });
    if (!q.ok) throw new Error("plan");
    const x = build(q, now);
    expect(x.line_items.filter(isOneTime)).toHaveLength(0);
    expect(x.metadata[CATCHUP_META.stubCents]).toBe("0");
  });
});

describe("trial shape (prepaid; October paid, paid-through Nov 1)", () => {
  const p = plan({ invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")] });
  const params = build(p);

  it("trial_end = T alone, recurring lines only, catchup=prepaid", () => {
    expect(p.shape).toBe("trial");
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.subscription_data).not.toHaveProperty("billing_cycle_anchor");
    expect(params.subscription_data).not.toHaveProperty("proration_behavior");
    expect(params.line_items.filter(isOneTime)).toHaveLength(0);
    expect(params.metadata).toMatchObject({
      [CATCHUP_META.catchup]: "prepaid",
      [CATCHUP_META.shape]: "trial",
      [CATCHUP_META.stubCents]: "0",
    });
  });

  it("with a stub (paid through Nov 14) the 17/30 stub rides the metadata for the post-completion draft invoice", () => {
    const q = plan({
      invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")],
    });
    const x = build(q);
    expect(x.subscription_data.trial_end).toBe(Date.UTC(2026, 11, 1, 12) / 1000);
    expect(q.stub.totalCents).toBe(17567);
    expect(x.metadata[CATCHUP_META.stubCents]).toBe("17567");
    expect(x.metadata[CATCHUP_META.finalizeAt]).toBe(String(Date.UTC(2026, 10, 14, 12) / 1000));
    expect(x.line_items.filter(isOneTime)).toHaveLength(0); // the stub is NEVER a Checkout line here
  });
});

describe("anchor_no_line (prepaid through Nov 1, session Oct 30)", () => {
  const now = d("2026-10-30T09:00:00Z");
  const p = plan({
    now,
    invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")],
  });
  const params = build(p, now);

  it("billing_cycle_anchor + proration none and NO one-time line", () => {
    expect(p.shape).toBe("anchor_no_line");
    expect(params.subscription_data.billing_cycle_anchor).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.subscription_data.proration_behavior).toBe("none");
    expect(params.subscription_data).not.toHaveProperty("trial_end");
    expect(params.line_items.filter(isOneTime)).toHaveLength(0);
    expect(params.metadata[CATCHUP_META.catchup]).toBe("prepaid");
  });

  it("expires BEFORE the anchor (a session completing after it would be charged the full period)", () => {
    expect(params.expires_at * 1000).toBeLessThanOrEqual(Date.UTC(2026, 10, 1, 11));
  });
});

describe("R5-4 pin: across EVERY shape and instant, the built params never pair the invalid combinations", () => {
  it("no one-time line beside proration_behavior; no trial_end beside billing_cycle_anchor; trial_end >= 72 h out", () => {
    const histories: CatchupInvoice[][] = [
      [],
      [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")],
      [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")],
      [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-10-20T12:00:00Z")],
      [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-12-01T12:00:00Z")],
    ];
    const seen = new Set<string>();
    for (const invoices of histories) {
      for (let h = 24; h < 24 * 75; h += 11) {
        const now = new Date(Date.UTC(2026, 9, 2, 0, 0, 0) + h * 3600_000 + 13 * 60_000);
        const p = planCatchup({ now, monthly: 310, addons: [], invoices });
        if (!p.ok) continue;
        seen.add(p.shape);
        const params = build(p, now);
        const sd = params.subscription_data;
        if (params.line_items.some(isOneTime)) expect(sd.proration_behavior).toBeUndefined();
        if (sd.trial_end != null) {
          expect(sd.billing_cycle_anchor).toBeUndefined();
          expect(sd.trial_end * 1000 - now.getTime()).toBeGreaterThanOrEqual(72 * 3600_000);
        }
        expect(params.subscription_data.metadata.catchup).toMatch(/^(period|prepaid)$/);
      }
    }
    expect([...seen].sort()).toEqual(["anchor_no_line", "trial", "trial_one_time"]); // the sweep exercised all three
  });
});

describe("assertCheckoutAcceptable (Stripe's documented Checkout limits)", () => {
  const recurring = { price_data: { recurring: { interval: "month" } } };
  const oneTime = { price_data: { currency: "usd", unit_amount: 100 } };
  it("rejects a trial beside a billing_cycle_anchor", () => {
    expect(() =>
      assertCheckoutAcceptable({
        line_items: [recurring],
        subscription_data: { trial_end: 1, billing_cycle_anchor: 2 },
      }),
    ).toThrow(/trial combined with billing_cycle_anchor/);
    expect(() =>
      assertCheckoutAcceptable({
        line_items: [recurring],
        subscription_data: { trial_period_days: 3, billing_cycle_anchor: 2 },
      }),
    ).toThrow();
  });
  it("rejects a one-time line beside ANY proration_behavior", () => {
    for (const proration of ["none", "create_prorations"]) {
      expect(() =>
        assertCheckoutAcceptable({
          line_items: [recurring, oneTime],
          subscription_data: { billing_cycle_anchor: 2, proration_behavior: proration },
        }),
      ).toThrow(/one-time line must not be paired with proration_behavior/);
    }
  });
  it("accepts the documented combinations", () => {
    expect(() =>
      assertCheckoutAcceptable({ line_items: [recurring], subscription_data: { trial_end: 1 } }),
    ).not.toThrow();
    expect(() =>
      assertCheckoutAcceptable({
        line_items: [recurring, oneTime],
        subscription_data: { trial_end: 1 },
      }),
    ).not.toThrow();
    expect(() =>
      assertCheckoutAcceptable({
        line_items: [recurring],
        subscription_data: { billing_cycle_anchor: 2, proration_behavior: "none" },
      }),
    ).not.toThrow();
  });
});
