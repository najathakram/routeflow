import { buildCatchupSessionParams, assertCheckoutAcceptable } from "./catchup-session-params";
import { planCatchup, type CatchupInvoice } from "./catchup-plan";
import { CATCHUP_META } from "./catchup-claim";

/**
 * SA-733 D7 against Stripe's DOCUMENTED Checkout limits (docs.stripe.com/payments/checkout/billing-cycle,
 * "Limitations"): no trial with a billing cycle anchor, no one-time price with proration_behavior none. The
 * session params are a pure function of the plan, so the whole matrix is asserted here with no Stripe at all.
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

function plan(over: { now?: Date; invoices?: CatchupInvoice[] } = {}) {
  const p = planCatchup({
    now: over.now ?? NOW,
    monthly: 310,
    addons: [],
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

describe("trial shape (October paid; paid-through Nov 1)", () => {
  const p = plan({ invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")] });
  const params = build(p);

  it("trial_end = T alone: NO explicit billing_cycle_anchor, no proration_behavior", () => {
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.subscription_data).not.toHaveProperty("billing_cycle_anchor");
    expect(params.subscription_data).not.toHaveProperty("proration_behavior");
  });

  it("only RECURRING lines (the stub is a post-completion invoice, never a Checkout line)", () => {
    for (const li of params.line_items) expect(li.price_data.recurring).toBeDefined();
    expect(params.mode).toBe("subscription");
    expect(params.payment_method_collection).toBe("always");
  });

  it("session + subscription metadata carry the catch-up marker the webhook acts on", () => {
    expect(params.metadata).toMatchObject({
      tenantId: "t1",
      planKey: "GROWTH",
      interval: "month",
      [CATCHUP_META.catchup]: "prepaid",
      [CATCHUP_META.shape]: "trial",
      [CATCHUP_META.stubCents]: "0",
    });
    expect(params.subscription_data.metadata).toMatchObject({ tenantId: "t1", catchup: "prepaid" });
  });

  it("the session lives 24 h (the trial end is days away)", () => {
    expect(params.expires_at).toBe(Math.floor((NOW.getTime() + 24 * 3600_000) / 1000));
  });
});

describe("trial shape with a stub (paid through Nov 14)", () => {
  const p = plan({ invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")] });
  const params = build(p);
  it("trial_end = Dec 1 12:00Z; the 17/30 stub rides the metadata for the post-completion invoice", () => {
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 11, 1, 12) / 1000);
    expect(p.stub.totalCents).toBe(17567); // 310 x 17/30 = 175.67
    expect(params.metadata[CATCHUP_META.stubCents]).toBe("17567");
    expect(params.metadata[CATCHUP_META.stubLabel]).toMatch(/Subscription/);
    expect(params.metadata[CATCHUP_META.finalizeAt]).toBe(
      String(Date.UTC(2026, 10, 14, 12) / 1000),
    );
  });
});

describe("anchor_no_line shape (paid through Nov 1, checkout Oct 30)", () => {
  const now = d("2026-10-30T09:00:00Z");
  const p = plan({
    now,
    invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")],
  });
  const params = build(p, now);

  it("billing_cycle_anchor + proration none, and NO one-time line (Checkout would reject one)", () => {
    expect(params.subscription_data.billing_cycle_anchor).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.subscription_data.proration_behavior).toBe("none");
    expect(params.subscription_data).not.toHaveProperty("trial_end");
    for (const li of params.line_items) expect(li.price_data.recurring).toBeDefined();
  });

  it("expires BEFORE the anchor (a session completing after it would be charged the full period)", () => {
    expect(params.expires_at * 1000).toBeLessThanOrEqual(Date.UTC(2026, 10, 1, 11));
  });
});

describe("add-on lines", () => {
  it("ride as recurring lines with their SKUs on the session AND the subscription", () => {
    const p = plan({
      invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")],
    });
    const params = build(p, NOW, true);
    expect(params.line_items).toHaveLength(2);
    expect(params.metadata.addonSkus).toBe("FORECASTING");
    expect(params.subscription_data.metadata.addonSkus).toBe("FORECASTING");
  });
});

describe("the shape Checkout rejects is never built", () => {
  it("needs_ruling (nothing paid; the D7 one-time line + anchor + proration none) throws, not a workaround", () => {
    const p = plan();
    expect(p.shape).toBe("needs_ruling");
    expect(() => build(p)).toThrow(/needs a ruling/);
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
  it("rejects a one-time line with proration_behavior none", () => {
    expect(() =>
      assertCheckoutAcceptable({
        line_items: [recurring, oneTime],
        subscription_data: { billing_cycle_anchor: 2, proration_behavior: "none" },
      }),
    ).toThrow(/one-time line with proration_behavior=none/);
  });
  it("accepts the documented combinations", () => {
    expect(() =>
      assertCheckoutAcceptable({ line_items: [recurring], subscription_data: { trial_end: 1 } }),
    ).not.toThrow();
    expect(() =>
      assertCheckoutAcceptable({
        line_items: [recurring],
        subscription_data: { billing_cycle_anchor: 2, proration_behavior: "none" },
      }),
    ).not.toThrow();
    // a one-time line is fine with create_prorations (the new-subscription default)
    expect(() =>
      assertCheckoutAcceptable({
        line_items: [recurring, oneTime],
        subscription_data: { billing_cycle_anchor: 2, proration_behavior: "create_prorations" },
      }),
    ).not.toThrow();
  });
});
