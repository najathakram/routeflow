import { CatchupCheckoutService, catchupReportJson } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";

/**
 * SA-733r9 + r10 (row 339, the prorated catch-up) - PHASE 1 red rows through the existing public entry points:
 * `CatchupCheckoutService.plan()` / `open()` over the in-memory store and the stateful Stripe fake (no network;
 * the claim service is the REAL one). RED = fails on master 5a938f0a2 today; PIN = green today, kept as a guard.
 *
 * Fixtures use `acme`-style placeholders only. Where a row needs the activation audit rows they are the rows the
 * platform-admin activation writes (marker with the recorded period + the post-commit trail row).
 */
const d = (iso: string) => new Date(iso);
const T = "t1";
const OCT_OPEN = {
  id: "inv_oct_open",
  tenantId: T,
  status: "OPEN",
  number: "RF-1",
  periodStart: d("2026-10-01T12:00:00Z"),
  periodEnd: d("2026-11-01T12:00:00Z"),
  periodKey: "k-oct",
};
const paid = (id: string, start: string, end: string) => ({
  ...OCT_OPEN,
  id,
  status: "PAID",
  periodStart: d(start),
  periodEnd: d(end),
  periodKey: `k-${id}`,
});
const open = (id: string, start: string, end: string) => ({
  ...paid(id, start, end),
  status: "OPEN",
});

function activationRows(
  h: { db: { audits: Record<string, unknown>[] } },
  start: string,
  end: string,
  opts: { markerPeriod?: boolean; trailPeriod?: boolean; startInMeta?: boolean } = {},
) {
  const { markerPeriod = true, trailPeriod = true, startInMeta = true } = opts;
  const at = d(start);
  h.db.audits.push(
    {
      tenantId: T,
      entityType: "tenant",
      action: "TENANT_MANUAL_ACTIVATION_MARKER",
      createdAt: at,
      meta: markerPeriod
        ? {
            ...(startInMeta ? { periodStart: at.toISOString() } : {}),
            periodEnd: d(end).toISOString(),
          }
        : {},
    },
    {
      tenantId: T,
      entityType: "tenant",
      action: "TENANT_SUBSCRIPTION_ACTIVATED",
      createdAt: new Date(at.getTime() + 3000),
      meta: trailPeriod ? { periodEnd: d(end).toISOString() } : {},
    },
  );
}

function make(
  o: {
    sub?: Record<string, unknown>;
    invoices?: Record<string, unknown>[];
    monthly?: number | null;
    source?: "override" | "catalog";
  } = {},
) {
  const db = fakeCatchupDb({
    subs: [{ tenantId: T, planKey: "GROWTH", ...(o.sub ?? {}) }],
    invoices: o.invoices ?? [OCT_OPEN],
  });
  const prisma: any = {
    ...db.prisma,
    tenantAddon: { findMany: jest.fn(async () => []) },
    tenant: {
      findUnique: jest.fn(async () => ({
        id: T,
        slug: "qa-acme",
        status: "ACTIVE",
        deletedAt: null,
      })),
    },
  };
  const stripe = fakeStripeCatchup({
    subs: {
      sub_1: {
        id: "sub_1",
        customer: "cus_1",
        status: "trialing",
        latest_invoice: null,
        default_payment_method: "pm_1",
      },
    },
  });
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => {
      if (o.monthly === null) throw new Error("no price");
      return {
        planKey: "GROWTH",
        monthly: o.monthly ?? 310,
        source: o.source ?? "catalog",
        currency: "usd",
      };
    }),
    checkoutPriceData: jest.fn(async () => ({
      currency: "usd",
      unit_amount: Math.round((o.monthly ?? 310) * 100),
      recurring: { interval: "month" },
      product_data: { name: "RouteFlow Growth — monthly" },
    })),
  };
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => ({ lineItems: [], skus: [] })),
  };
  const claim = new CatchupClaimService(prisma, stripe as any, { emit: jest.fn() } as any);
  const billing: any = { ensureStripeCustomer: jest.fn(async () => "cus_1") };
  const svc = new CatchupCheckoutService(prisma, stripe as any, pricing, mutations, claim, billing);
  return { svc, claim, db, stripe, pricing, prisma, sub: () => db.subs[0] };
}
type H = ReturnType<typeof make>;

/** The ordinary completion handler's write + the session as Stripe reports it once complete. */
async function complete(h: H, sessionId: string) {
  h.sub().stripeSubId = "sub_1";
  const session = {
    ...h.stripe.sessions[sessionId],
    status: "complete",
    subscription: "sub_1",
    customer: "cus_1",
    payment_status: "no_payment_required",
    expires_at: Math.floor(d("2026-10-30T10:00:00Z").getTime() / 1000),
  };
  h.stripe.sessions[sessionId] = session;
  await h.claim.onSessionCompleted(session);
  return session;
}
const forgivenRows = (h: H) => h.db.audits.filter((a) => a.action === "catchup.minimum-forgiven");

describe("RED: the prorated start - the paid-through may be mid-month (r9 rule 2)", () => {
  const NOW = d("2026-10-12T10:00:00Z");

  it("P = Oct 10 (activation Sep 10 + 30 d), session Oct 12: trial_one_time, line 22/31 of October, trial_end Nov 1 12:00Z (today refused CATCHUP_MANUAL_PERIOD_AHEAD)", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-09-10T12:00:00Z", "2026-10-10T12:00:00Z");
    const r = await h.svc.plan(T, NOW);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    expect(r.ineligible).toEqual([]);
    expect(r.plan.stub.from.toISOString()).toBe("2026-10-10T12:00:00.000Z");
    expect(r.plan.stub.to.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.plan.stub.totalCents).toBe(22000); // $310 x 22/31
    expect(r.plan.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    // the OPEN October invoice straddles S: it is voided at settlement
    expect(r.plan.voidInvoiceIds).toEqual(["inv_oct_open"]);
  });

  it("... and open() sends it: trial_end = Nov 1 12:00Z, ONE one-time line of $220.00, catchup_from = Oct 10, catchup_to = Nov 1", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-09-10T12:00:00Z", "2026-10-10T12:00:00Z");
    const out = await h.svc.open(T, { now: NOW, expectedStubCents: 22000 });
    expect(out).toMatchObject({ shape: "trial_one_time", stubCents: 22000 });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.line_items.filter((l: any) => !l.price_data.recurring)).toHaveLength(1);
    expect(params.metadata.catchup_from).toBe("2026-10-10T12:00:00.000Z");
    expect(params.metadata.catchup_to).toBe("2026-11-01T12:00:00.000Z");
  });

  it("a PAID RfInvoice window ending Nov 14 (a FUTURE mid-month S, session Oct 9): trial_one_time for [Nov 14, Dec 1) = 17/30, charged at completion (today refused)", async () => {
    const h = make({ invoices: [paid("p", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")] });
    h.pricing.resolveTenantPricing.mockResolvedValue({
      planKey: "GROWTH",
      monthly: 300,
      source: "catalog",
      currency: "usd",
    });
    const r = await h.svc.plan(T, d("2026-10-09T10:00:00Z"));
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    expect(r.plan.stub.from.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(r.plan.stub.to.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(r.plan.stub.totalCents).toBe(17000); // $300 x 17/30
    expect(r.plan.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });

  it("first activation Oct 15 for 30 days (paid to Nov 14): ELIGIBLE - S = Nov 14, A = Dec 1, line 17/30 of November, labelled with its start (today: activated_after_go_live)", async () => {
    const h = make({ invoices: [open("next", "2026-11-14T12:00:00Z", "2026-12-01T12:00:00Z")] });
    activationRows(h, "2026-10-15T12:00:00Z", "2026-11-14T12:00:00Z");
    h.pricing.resolveTenantPricing.mockResolvedValue({
      planKey: "GROWTH",
      monthly: 300,
      source: "catalog",
      currency: "usd",
    });
    const r = await h.svc.plan(T, d("2026-10-20T10:00:00Z"));
    expect(r.ineligible).toEqual([]);
    expect(r.eligible).toBe(true);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    expect(r.plan.stub.from.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(r.plan.stub.to.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(r.plan.stub.totalCents).toBe(17000);
    expect(r.plan.stub.label).toBe("Subscription — Nov 14 to Nov 30, 2026");
    expect(r.plan.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(r.plan.voidInvoiceIds).toEqual(["next"]);
  });

  it("the floor's first activation: a cluster with an END but NO START uses its earliest `at` (Oct 15) as the start - eligible, not activated_after_go_live", async () => {
    const h = make({ invoices: [] });
    // marker at Oct 15 12:00Z carries no period; the trail row seconds later carries only the end
    activationRows(h, "2026-10-15T12:00:00Z", "2026-11-14T12:00:00Z", {
      markerPeriod: false,
      trailPeriod: true,
    });
    const r = await h.svc.plan(T, d("2026-10-20T10:00:00Z"));
    expect(r.ineligible).toEqual([]);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    expect(r.plan.stub.from.toISOString()).toBe("2026-11-14T12:00:00.000Z");
  });

  it("PIN: a cluster with NEITHER start nor end still refuses manual_marker_without_period", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-10-15T12:00:00Z", "2026-11-14T12:00:00Z", {
      markerPeriod: false,
      trailPeriod: false,
    });
    const r = await h.svc.plan(T, d("2026-10-20T10:00:00Z"));
    expect(r.plan).toEqual({ ok: false, reason: "manual_marker_without_period" });
  });
});

describe("RED: S snaps to a 1st within 24 h (r9 rule 2) - no half-days", () => {
  const NOW = d("2026-10-09T10:00:00Z");
  const noLine = async (h: H) => {
    const r = await h.svc.plan(T, NOW);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial" });
    if (!r.plan.ok) return;
    expect(r.plan.stub.from.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.plan.stub.to.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.plan.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.plan.stub.totalCents).toBe(0); // not 12 h = 0.5/31 of a month
    expect(r.plan.stub.lines).toEqual([]);
  };

  it("P = Nov 1 00:00Z by a PAID window in the legacy spelling: S = Nov 1 12:00Z = A, no line (the 8(e) trial)", async () => {
    await noLine(
      make({ invoices: [paid("legacy", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")] }),
    );
  });

  it("P = Nov 1 00:00Z by an ACTIVATION in the legacy spelling: the same", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
    await noLine(h);
  });

  it("P = Oct 31 20:00Z (16 h before the 1st, an activation end): S snaps to Nov 1 12:00Z = A, no line (today refused as a partial)", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-10-01T20:00:00Z", "2026-10-31T20:00:00Z");
    await noLine(h);
  });
});

describe("RED: one paid-coverage walk over activation AND paid-RfInvoice windows (r9 rule 1)", () => {
  it("activations Sep 10 -> Oct 10 and Oct 20 -> Nov 20: a gap at Oct 10 - paid_after_gap, asserted as the REASON and its coded refusal", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-09-10T12:00:00Z", "2026-10-10T12:00:00Z");
    activationRows(h, "2026-10-20T12:00:00Z", "2026-11-20T12:00:00Z");
    const r = await h.svc.plan(T, d("2026-10-22T10:00:00Z"));
    expect(r.plan).toEqual({ ok: false, reason: "paid_after_gap" });
    expect(r.eligible).toBe(false);
    expect(catchupReportJson(r).refusals).toEqual(["CATCHUP_NEEDS_RULING"]);
  });

  it("PIN: a PAID RfInvoice after a gap refuses paid_after_gap (reason asserted)", async () => {
    const h = make({
      invoices: [
        paid("oct", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z"),
        paid("dec", "2026-12-01T12:00:00Z", "2027-01-01T12:00:00Z"),
      ],
    });
    const r = await h.svc.plan(T, d("2026-10-09T10:00:00Z"));
    expect(r.plan).toEqual({ ok: false, reason: "paid_after_gap" });
  });
});

describe("RED: the plan price must be billable (r9 rule 7)", () => {
  const NOW = d("2026-10-09T10:00:00Z");

  it("a plan price of 0: refused with the coded CATCHUP_NO_BILLABLE_PRICE, nothing claimed, no Stripe call", async () => {
    const h = make({ monthly: 0, invoices: [OCT_OPEN] });
    const r = await h.svc.plan(T, NOW);
    expect(r.eligible).toBe(false);
    expect(r.plan).toEqual({ ok: false, reason: "no_billable_price" });
    expect(catchupReportJson(r).refusals).toContain("CATCHUP_NO_BILLABLE_PRICE");
    await expect(h.svc.open(T, { now: NOW, expectedStubCents: 0 })).rejects.toMatchObject({
      response: { code: "CATCHUP_NO_BILLABLE_PRICE" },
    });
    expect(h.sub().catchupState).toBeNull();
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("PIN: an unresolvable (null) plan price stays a refusal, listed as no_resolvable_price", async () => {
    const h = make({ monthly: null, invoices: [OCT_OPEN] });
    const r = await h.svc.plan(T, NOW);
    expect(r.eligible).toBe(false);
    expect(r.ineligible).toContain("no_resolvable_price");
    expect(r.plan.ok).toBe(false);
  });
});

describe("RED: a line under 50 cents is forgiven once per session and settles AT COMPLETION (r9 rules 5 + 7, MF5)", () => {
  /** Plan -> open -> complete -> replay; returns what the claim and the audit trail look like. */
  async function flow(h: H, now: Date) {
    const r = await h.svc.plan(T, now);
    expect(r.eligible).toBe(true);
    expect(r.plan.ok && r.plan.stub.totalCents).toBeLessThan(50); // the line is sub-minimum
    const expected = r.plan.ok ? r.plan.stub.totalCents : 0;
    const out = await h.svc.open(T, { now, expectedStubCents: expected });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    // the session never carries the sub-minimum line (Stripe rejects it) and says so in its metadata
    expect(params.line_items.filter((l: any) => !l.price_data.recurring)).toHaveLength(0);
    expect(params.metadata.catchup_stub_cents).toBe("0");
    const session = await complete(h, out.sessionId);
    return { out, session };
  }

  it("a 30-cent line (a $0.30 plan, nothing paid): the claim is SETTLED when the trialing subscription exists with its card - not parked until the first invoice", async () => {
    const h = make({ monthly: 0.3, invoices: [OCT_OPEN] });
    const { out, session } = await flow(h, d("2026-10-09T10:00:00Z"));
    expect(h.sub().catchupState).toBeNull(); // settled at completion
    expect(h.sub()).toMatchObject({ externalPayment: false, catchupSessionId: null });
    expect(h.db.invoices.find((i) => i.id === "inv_oct_open")!.status).toBe("VOID");
    // exactly one forgiven row for the session: tenantId, cents and the session id
    expect(forgivenRows(h)).toHaveLength(1);
    expect(forgivenRows(h)[0]).toMatchObject({ tenantId: T });
    expect(forgivenRows(h)[0].meta).toMatchObject({ cents: 30, sessionId: out.sessionId });
    // a replay (redelivered completion, a second settle) writes none
    await h.claim.onSessionCompleted(session);
    await h.claim.settle(T, "sub_1");
    expect(forgivenRows(h)).toHaveLength(1);
  });

  it("the realistic case: PAID to Oct 31 11:00Z on a $9 plan leaves a 25-hour (30-cent) line [Oct 31 11:00, Nov 1 12:00): forgiven, one audit row, settled at completion", async () => {
    const h = make({
      monthly: 9,
      invoices: [paid("p", "2026-10-01T12:00:00Z", "2026-10-31T11:00:00Z")],
    });
    const { out } = await flow(h, d("2026-10-20T10:00:00Z"));
    expect(h.sub().catchupState).toBeNull();
    expect(forgivenRows(h)).toHaveLength(1);
    expect(forgivenRows(h)[0].meta).toMatchObject({ cents: 30, sessionId: out.sessionId });
  });
});

describe("S2: the $0.50 boundary through the claim (49 forgiven once, 50 and 51 charged with no audit row)", () => {
  async function run(monthly: number) {
    const h = make({ monthly, invoices: [OCT_OPEN] });
    const now = d("2026-10-09T10:00:00Z");
    const r = await h.svc.plan(T, now);
    const expected = r.plan.ok ? r.plan.stub.totalCents : -1;
    const out = await h.svc.open(T, { now, expectedStubCents: expected });
    const session = await complete(h, out.sessionId);
    return { h, out, session, params: h.stripe.client.checkout.sessions.create.mock.calls[0][0] };
  }

  it("49 cents: forgiven - no line, settled at completion, EXACTLY one catchup.minimum-forgiven row (none on replay)", async () => {
    const { h, out, session } = await run(0.49);
    expect(h.sub().catchupState).toBeNull();
    expect(forgivenRows(h)).toHaveLength(1);
    expect(forgivenRows(h)[0].meta).toMatchObject({ cents: 49, sessionId: out.sessionId });
    await h.claim.onSessionCompleted(session);
    expect(forgivenRows(h)).toHaveLength(1);
  });

  it.each([0.5, 0.51])(
    "%s dollars: a real $0.50+ line is charged - one line, NO audit row, the claim waits for the money",
    async (monthly) => {
      const { h, params } = await run(monthly);
      expect(params.line_items.filter((l: any) => !l.price_data.recurring)).toHaveLength(1);
      expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
      expect(forgivenRows(h)).toHaveLength(0);
    },
  );
});

describe("RED: the Enterprise scenario numbers (r10): $100 override, activation [Oct 12, Nov 11) at its recorded time of day", () => {
  // 04:08:24Z is the time of day that makes the stub span exactly 20.3275 days: Dec 1 12:00Z - Nov 11 04:08:24Z
  const START = "2026-10-12T04:08:24Z";
  const END = "2026-11-11T04:08:24Z";
  const enterprise = () => {
    const h = make({ monthly: 100, source: "override", invoices: [] });
    activationRows(h, START, END);
    return h;
  };

  it("session ~Oct 12: stub $67.76 (spanFactor 20.3275 / 30 x $100), A = Dec 1 12:00Z", async () => {
    const r = await enterprise().svc.plan(T, d("2026-10-12T10:00:00Z"));
    expect(r.ineligible).toEqual([]);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    expect(r.priceSource).toBe("override");
    expect(r.plan.stub.from.toISOString()).toBe("2026-11-11T04:08:24.000Z");
    expect(r.plan.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(r.plan.stub.lines).toEqual([{ kind: "PLAN", code: "PLAN", cents: 6776 }]);
    expect(r.plan.stub.totalCents).toBe(6776);
  });

  it("the same tenant, session on Nov 29: A = Jan 1 12:00Z, stub $167.76 (Nov 11 -> Jan 1, contiguous)", async () => {
    const r = await enterprise().svc.plan(T, d("2026-11-29T10:00:00Z"));
    expect(r.ineligible).toEqual([]);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    expect(r.plan.trialEndAt.toISOString()).toBe("2027-01-01T12:00:00.000Z");
    expect(r.plan.stub.totalCents).toBe(16776);
  });
});

describe("the dry-run report carries planKey and the resolved basePriceSnapshot (r10 nit 3)", () => {
  it("PIN: planKey is in the JSON report", async () => {
    const h = make({ monthly: 100, source: "override" });
    expect(catchupReportJson(await h.svc.plan(T, d("2026-10-09T10:00:00Z"))).planKey).toBe(
      "GROWTH",
    );
  });

  it("RED: basePriceSnapshot is a key of the JSON report (null when an override exists with no snapshot, so the tool can flag it)", async () => {
    const h = make({ monthly: 100, source: "override", sub: { basePriceSnapshot: null } });
    const json = catchupReportJson(await h.svc.plan(T, d("2026-10-09T10:00:00Z")));
    expect(Object.keys(json)).toContain("basePriceSnapshot");
  });
});

describe("PIN: the reachable shapes and the refusal reasons (the G4 inventory)", () => {
  /** Every plan the service can produce over a spread of paid states and session days (refusals skipped). */
  async function reachablePlans() {
    const states: { invoices: Record<string, unknown>[]; act?: [string, string] }[] = [
      { invoices: [OCT_OPEN] },
      { invoices: [paid("o", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")] },
      { invoices: [paid("o", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")] },
      { invoices: [paid("o", "2026-10-01T12:00:00Z", "2026-10-30T12:00:00Z")] },
      { invoices: [paid("o", "2026-10-01T12:00:00Z", "2026-11-29T12:00:00Z")] },
      { invoices: [paid("o", "2026-10-01T12:00:00Z", "2026-12-01T12:00:00Z")] },
      { invoices: [paid("o", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")] },
      { invoices: [], act: ["2026-09-10T12:00:00Z", "2026-10-10T12:00:00Z"] },
      { invoices: [], act: ["2026-10-15T12:00:00Z", "2026-11-14T12:00:00Z"] },
      { invoices: [], act: ["2026-09-01T12:00:00Z", "2027-09-01T12:00:00Z"] },
    ];
    const days = [
      "2026-10-09T10:00:00Z",
      "2026-10-12T10:00:00Z",
      "2026-10-28T04:00:00Z",
      "2026-10-29T04:00:00Z",
      "2026-10-30T09:00:00Z",
      "2026-11-27T10:00:00Z",
      "2026-11-29T10:00:00Z",
    ];
    const plans: {
      now: Date;
      plan: Extract<Awaited<ReturnType<H["svc"]["plan"]>>["plan"], { ok: true }>;
    }[] = [];
    for (const s of states) {
      for (const day of days) {
        const h = make({ invoices: s.invoices });
        if (s.act) activationRows(h, s.act[0], s.act[1]);
        const r = await h.svc.plan(T, d(day));
        if (r.plan.ok) plans.push({ now: d(day), plan: r.plan });
      }
    }
    return plans;
  }

  it("PIN: a prepaid shape (trial / anchor_no_line) never carries a stub - the 98 h trial-with-stub is unreachable", async () => {
    const plans = await reachablePlans();
    expect(plans.length).toBeGreaterThan(10);
    for (const { plan } of plans) {
      if (plan.shape === "trial" || String(plan.shape) === "anchor_no_line") {
        expect(plan.stub.totalCents).toBe(0);
        expect(plan.stub.lines).toEqual([]);
      }
    }
    expect(plans.some((p) => p.plan.shape === "trial_one_time")).toBe(true);
    expect(plans.some((p) => p.plan.shape === "trial")).toBe(true);
  });

  it("RED: anchor_no_line is unreachable - every S < A is trial_one_time and the stub-free trial has S === A >= now + 72 h", async () => {
    const plans = await reachablePlans();
    for (const { now, plan } of plans) {
      expect(plan.shape).not.toBe("anchor_no_line");
      if (plan.shape === "trial") {
        expect(plan.stub.from.getTime()).toBe(plan.stub.to.getTime()); // S === A
        expect(plan.trialEndAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(72 * 3600_000);
      }
    }
  });

  it.each([
    [
      "manual_marker_without_period",
      () => {
        const h = make({ invoices: [OCT_OPEN] });
        activationRows(h, "2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z", {
          markerPeriod: false,
          trailPeriod: false,
        });
        return h;
      },
    ],
    ["claim_held", () => make({ sub: { catchupState: "SESSION_OPEN" } })],
    ["has_stripe_subscription", () => make({ sub: { stripeSubId: "sub_x" } })],
    [
      "unplaceable_open_invoice",
      () =>
        make({
          invoices: [{ ...OCT_OPEN, id: "x", periodStart: null, periodEnd: null, periodKey: "kx" }],
        }),
    ],
  ])("PIN: the refusal %s is a listed reason", async (reason, build) => {
    const r = await build().svc.plan(T, d("2026-10-09T10:00:00Z"));
    expect(r.eligible).toBe(false);
    expect(r.ineligible).toContain(reason);
  });

  it("PIN: a line total of 0 (S === A) is NOT a refusal - it is the eligible trial shape", async () => {
    const h = make({ invoices: [paid("o", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z")] });
    const r = await h.svc.plan(T, d("2026-10-09T10:00:00Z"));
    expect(r.eligible).toBe(true);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial" });
  });
});
