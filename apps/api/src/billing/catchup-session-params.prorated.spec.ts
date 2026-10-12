import { buildCatchupSessionParams } from "./catchup-session-params";
import { planCatchup, type CatchupInvoice, type CatchupPlan } from "./catchup-plan";
import { CATCHUP_META } from "./catchup-claim";

/**
 * SA-733r10 MF-B + r9 rule 3 - PHASE 1 rows for the Checkout session params, a PURE function of the plan.
 *   RED MF-B  every shape builder writes BOTH `catchup_from` (= S) and `catchup_to` (= A) on the session metadata,
 *             so one metadata contract serves settle - including the no-line trial that writes neither today.
 *   PIN       no coupons: the params never carry `discounts` and never `allow_promotion_codes: true`.
 */
const d = (iso: string) => new Date(iso);
const inv = (id: string, status: string, start: string, end: string): CatchupInvoice => ({
  id,
  status,
  periodStart: d(start),
  periodEnd: d(end),
});
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

const build = (plan: CatchupPlan, now: Date, addon = false) =>
  buildCatchupSessionParams({
    tenantId: "t1",
    slug: "acme",
    planKey: "GROWTH",
    customerId: "cus_1",
    planPriceData: PLAN_LINE,
    addonLines: addon ? [ADDON_LINE] : [],
    addonSkus: addon ? ["FORECASTING"] : [],
    plan,
    now,
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
  });

/** Plans that exercise every shape the planner can still name today, built through the pure planner. */
const CASES: { name: string; now: string; invoices: CatchupInvoice[]; addon?: boolean }[] = [
  { name: "nothing paid (trial_one_time)", now: "2026-10-09T10:00:00Z", invoices: [] },
  {
    name: "nothing paid + an add-on (trial_one_time)",
    now: "2026-10-09T10:00:00Z",
    invoices: [],
    addon: true,
  },
  {
    name: "October paid, session Oct 9 (the stub-free 8(e) trial, S === A)",
    now: "2026-10-09T10:00:00Z",
    invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")],
  },
  {
    name: "two months paid, session Oct 9 (the stub-free trial to Dec 1)",
    now: "2026-10-09T10:00:00Z",
    invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-12-01T12:00:00Z")],
  },
  {
    name: "paid to Nov 14, session Oct 9 (a prepaid trial with a stub today)",
    now: "2026-10-09T10:00:00Z",
    invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")],
  },
  {
    name: "October paid, session Oct 30 (anchor_no_line today)",
    now: "2026-10-30T09:00:00Z",
    invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")],
  },
  {
    name: "paid to Oct 30 12:00, session Oct 29 (a mid-month line 1-3 days from a 1st)",
    now: "2026-10-29T04:00:00Z",
    invoices: [inv("o", "PAID", "2026-10-01T12:00:00Z", "2026-10-30T12:00:00Z")],
  },
];

const paramsFor = (c: (typeof CASES)[number]) => {
  const now = d(c.now);
  const plan = planCatchup({
    now,
    monthly: 310,
    addons: c.addon ? [{ sku: "FORECASTING", unitPrice: 31, quantity: 1 }] : [],
    invoices: c.invoices,
  });
  if (!plan.ok) throw new Error(`${c.name}: ${plan.reason}`);
  return { plan, params: build(plan, now, c.addon) };
};

describe("RED MF-B: every shape writes catchup_from AND catchup_to on the session metadata", () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s: both keys present, parse as instants, catchup_to >= catchup_from",
    (_name, c) => {
      const { plan, params } = paramsFor(c);
      const m = params.metadata as Record<string, string>;
      for (const key of [CATCHUP_META.from, CATCHUP_META.to]) {
        expect(typeof m[key]).toBe("string");
        expect(Number.isNaN(Date.parse(m[key]))).toBe(false);
      }
      expect(Date.parse(m[CATCHUP_META.to])).toBeGreaterThanOrEqual(
        Date.parse(m[CATCHUP_META.from]),
      );
      // S and A themselves, exactly as the plan states them
      expect(m[CATCHUP_META.from]).toBe(plan.stub.from.toISOString());
      expect(m[CATCHUP_META.to]).toBe(plan.stub.to.toISOString());
    },
  );

  it("the stub-free 8(e) trial (S === A) writes the SAME instant under both keys", () => {
    const { params } = paramsFor(CASES[2]);
    const m = params.metadata as Record<string, string>;
    expect(m[CATCHUP_META.from]).toBe("2026-11-01T12:00:00.000Z");
    expect(m[CATCHUP_META.to]).toBe("2026-11-01T12:00:00.000Z");
  });

  it("PIN: trial_one_time already writes both keys, on the session AND the subscription", () => {
    const { params } = paramsFor(CASES[0]);
    expect(params.metadata).toMatchObject({
      [CATCHUP_META.from]: "2026-10-01T12:00:00.000Z",
      [CATCHUP_META.to]: "2026-11-01T12:00:00.000Z",
    });
    expect(params.subscription_data.metadata).toMatchObject({
      [CATCHUP_META.from]: "2026-10-01T12:00:00.000Z",
      [CATCHUP_META.to]: "2026-11-01T12:00:00.000Z",
    });
  });
});

describe("PIN (r9 rule 3): no coupons in the catch-up - the paid amount always equals the promised stub", () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s: no `discounts`, no `allow_promotion_codes: true`, on the session or the subscription data",
    (_name, c) => {
      const { params } = paramsFor(c);
      expect(params).not.toHaveProperty("discounts");
      expect(params.allow_promotion_codes).not.toBe(true);
      expect(params.subscription_data ?? {}).not.toHaveProperty("discounts");
      expect(params.subscription_data ?? {}).not.toHaveProperty("coupon");
      for (const li of params.line_items) expect(li).not.toHaveProperty("discounts");
    },
  );
});
