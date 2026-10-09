import { CatchupCheckoutService, catchupReportJson } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-733 D7: planning (read-only) and opening the catch-up. Stripe is the stateful fake: no network. The claim
 * service is the REAL one over the in-memory store, so "the claim exists before Stripe is called" is asserted
 * from what the store held when `sessions.create` ran.
 */
const NOW = new Date("2026-10-09T10:00:00Z");
const OCT_PAID = {
  id: "inv_oct",
  tenantId: "t1",
  status: "PAID",
  number: "RF-1",
  periodStart: new Date("2026-10-01T12:00:00Z"),
  periodEnd: new Date("2026-11-01T12:00:00Z"),
  periodKey: "k1",
};
const OCT_OPEN = { ...OCT_PAID, id: "inv_oct_open", status: "OPEN", periodKey: "k2" };

function make(
  o: {
    sub?: Record<string, unknown>;
    tenant?: Record<string, unknown>;
    invoices?: Record<string, unknown>[];
    monthly?: number | null;
    addonLines?: any[];
  } = {},
) {
  const db = fakeCatchupDb({
    subs: [{ tenantId: "t1", planKey: "GROWTH", ...(o.sub ?? {}) }],
    invoices: o.invoices ?? [OCT_PAID],
  });
  const prisma: any = {
    ...db.prisma,
    tenant: {
      findUnique: jest.fn(async () => ({
        id: "t1",
        slug: "qa-acme",
        status: "ACTIVE",
        deletedAt: null,
        ...(o.tenant ?? {}),
      })),
    },
  };
  const stripe = fakeStripeCatchup();
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => {
      if (o.monthly === null) throw new Error("no price");
      return { planKey: "GROWTH", monthly: o.monthly ?? 310, source: "catalog", currency: "usd" };
    }),
    checkoutPriceData: jest.fn(async () => ({
      currency: "usd",
      unit_amount: 31000,
      recurring: { interval: "month" },
      product_data: { name: "RouteFlow Growth — monthly" },
    })),
  };
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => ({
      lineItems: o.addonLines ?? [],
      skus: (o.addonLines ?? []).map((l) => l.price_data.product_data.metadata.addonSku),
    })),
  };
  const claim = new CatchupClaimService(prisma, stripe as any, { emit: jest.fn() } as any);
  const billing: any = { ensureStripeCustomer: jest.fn(async () => "cus_1") };
  const svc = new CatchupCheckoutService(prisma, stripe as any, pricing, mutations, claim, billing);
  return { svc, db, stripe, pricing, mutations, billing, prisma, sub: () => db.subs[0] };
}

describe("plan() is a read-only dry-run", () => {
  it("writes nothing and calls no Stripe; the add-on lines are read QUIETLY (no platform notice)", async () => {
    const h = make();
    const r = await h.svc.plan("t1", NOW);
    expect(r.eligible).toBe(true);
    expect(h.db.audits).toHaveLength(0);
    expect(h.db.locks).toHaveLength(0);
    expect(h.stripe.calls).toEqual([]);
    expect(h.mutations.checkoutAddonLines).toHaveBeenCalledWith("t1", "month", { quiet: true });
    expect(h.sub().catchupState).toBeNull();
  });

  it("reports the October line: nothing paid => the full monthly price as trial_one_time, ELIGIBLE (SA-733r5)", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    const r = await h.svc.plan("t1", NOW);
    expect(r.monthlyCents).toBe(31000);
    expect(r.priceSource).toBe("catalog");
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    expect(r.plan.ok && r.plan.stub).toMatchObject({
      totalCents: 31000,
      label: "Subscription — October 2026",
    });
    expect(r.plan.ok && r.plan.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.eligible).toBe(true);
    expect(r.ineligible).toEqual([]);
    expect(r.rfInvoices).toEqual({ open: 1, paid: 0 });
  });

  it("October PAID => the trial shape, $0 stub, eligible", async () => {
    const r = await make().svc.plan("t1", NOW);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial" });
    expect(r.plan.ok && r.plan.stub.totalCents).toBe(0);
    expect(r.eligible).toBe(true);
  });

  it("the add-on lines (the ones the recurring subscription will bill) are part of the stub", async () => {
    const addon = {
      price_data: { unit_amount: 3100, product_data: { metadata: { addonSku: "FORECASTING" } } },
      quantity: 2,
    };
    const h = make({
      invoices: [{ ...OCT_PAID, periodEnd: new Date("2026-11-14T12:00:00Z") }],
      addonLines: [addon],
    });
    const r = await h.svc.plan("t1", NOW);
    expect(r.plan.ok && r.plan.stub.lines.map((l) => l.code)).toEqual(["PLAN", "FORECASTING"]);
  });

  it.each([
    ["has_stripe_subscription", { sub: { stripeSubId: "sub_x" } }],
    ["not_manual_invoicing", { sub: { externalPayment: false } }],
    ["claim_held", { sub: { catchupState: "SESSION_OPEN" } }],
    ["tenant_not_active", { tenant: { status: "READ_ONLY" } }],
    ["no_resolvable_price", { monthly: null }],
  ] as const)("ineligible: %s", async (reason, o) => {
    const r = await make(o as any).svc.plan("t1", NOW);
    expect(r.eligible).toBe(false);
    expect(r.ineligible).toContain(reason);
  });

  it("a PAID RfInvoice after a gap: the plan itself refuses", async () => {
    const gap = {
      ...OCT_PAID,
      id: "g",
      periodKey: "kg",
      periodStart: new Date("2026-12-01T12:00:00Z"),
      periodEnd: new Date("2027-01-01T12:00:00Z"),
    };
    const r = await make({ invoices: [OCT_PAID, gap] }).svc.plan("t1", NOW);
    expect(r.plan).toEqual({ ok: false, reason: "paid_after_gap" });
    expect(r.eligible).toBe(false);
  });

  it("the JSON view has no Date objects and no names", async () => {
    const r = await make().svc.plan("t1", NOW);
    const json = catchupReportJson(r);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(JSON.stringify(json)).not.toContain("qa-acme");
  });
});

describe("census()", () => {
  it("plans every active production tenant read-only: ids and counts, a broken tenant is counted, not fatal", async () => {
    const h = make();
    h.prisma.tenantSubscription = {
      ...h.prisma.tenantSubscription,
      findMany: jest.fn(async () => [{ tenantId: "t1" }, { tenantId: "t_bad" }]),
    };
    const realFind = h.prisma.tenant.findUnique;
    h.prisma.tenant.findUnique = jest.fn(async (a: any) =>
      a.where.id === "t_bad" ? null : realFind(a),
    );
    const c = await h.svc.census(NOW);
    expect(c.counts).toMatchObject({ total: 2, planned: 1, failed: 1, eligible: 1, trial: 1 });
    expect(c.failed).toEqual(["t_bad"]);
    expect(JSON.stringify(c)).not.toContain("qa-acme");
    expect(h.db.audits).toHaveLength(0);
    expect(h.stripe.calls).toEqual([]);
    const where = (h.prisma.tenantSubscription.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toEqual({ tenant: { status: "ACTIVE", deletedAt: null, class: "PRODUCTION" } });
  });
});

describe("open()", () => {
  it("the claim is written BEFORE Stripe is called, the session id stored after, and the amount pinned", async () => {
    const h = make();
    const heldAtCreate: unknown[] = [];
    h.stripe.client.checkout.sessions.create.mockImplementationOnce(async (params: any) => {
      heldAtCreate.push({ ...h.sub() });
      return { id: "cs_new", url: "https://pay.test/cs_new", params };
    });
    const out = await h.svc.open("t1", { now: NOW, expectedStubCents: 0 });
    expect(heldAtCreate[0]).toMatchObject({ catchupState: "SESSION_OPEN", catchupSessionId: null });
    expect(out).toMatchObject({ sessionId: "cs_new", shape: "trial", stubCents: 0 });
    expect(h.sub()).toMatchObject({ catchupState: "SESSION_OPEN", catchupSessionId: "cs_new" });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.customer).toBe("cus_1");
  });

  it("a Stripe failure drops the claim and surfaces fixed copy (nothing charged)", async () => {
    const h = make();
    h.stripe.client.checkout.sessions.create.mockRejectedValueOnce(
      new Error("stripe: card details leaked"),
    );
    const err: any = await h.svc.open("t1", { now: NOW }).catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(JSON.stringify(err.getResponse())).not.toContain("leaked");
    expect(h.sub().catchupState).toBeNull();
  });

  it("the common case (unpaid October) opens a trial_one_time session: trial_end = A, ONE one-time line, no anchor, no proration_behavior", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    const out = await h.svc.open("t1", { now: NOW, expectedStubCents: 31000 });
    expect(out).toMatchObject({ shape: "trial_one_time", stubCents: 31000 });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.subscription_data).not.toHaveProperty("billing_cycle_anchor");
    expect(params.subscription_data).not.toHaveProperty("proration_behavior");
    expect(params.line_items.filter((l: any) => !l.price_data.recurring)).toHaveLength(1);
    expect(params.metadata.catchup).toBe("period");
    expect(h.sub()).toMatchObject({
      catchupState: "SESSION_OPEN",
      catchupSessionId: out.sessionId,
    });
  });

  it("a non-contiguous PAID gap: 409 CATCHUP_NEEDS_RULING, no claim, no Stripe call", async () => {
    const gap = {
      ...OCT_PAID,
      id: "g",
      periodKey: "kg",
      periodStart: new Date("2026-12-01T12:00:00Z"),
      periodEnd: new Date("2027-01-01T12:00:00Z"),
    };
    const h = make({ invoices: [OCT_PAID, gap] });
    await expect(h.svc.open("t1", { now: NOW })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_NEEDS_RULING },
    });
    expect(h.sub().catchupState).toBeNull();
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("a tenant that already has a Stripe subscription is NEEDS RULING (census), before anything is written", async () => {
    const h = make({ sub: { stripeSubId: "sub_x" } });
    await expect(h.svc.open("t1", { now: NOW })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_NEEDS_RULING },
    });
    expect(h.db.locks).toHaveLength(0);
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("an amount that moved since the dry-run: 409 CATCHUP_AMOUNT_CHANGED, nothing created", async () => {
    const h = make({ invoices: [{ ...OCT_PAID, periodEnd: new Date("2026-11-14T12:00:00Z") }] });
    await expect(h.svc.open("t1", { now: NOW, expectedStubCents: 999 })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_AMOUNT_CHANGED },
    });
    expect(h.sub().catchupState).toBeNull();
  });

  it("a second open while a claim is held is refused (exactly one session per tenant)", async () => {
    const h = make();
    await h.svc.open("t1", { now: NOW });
    await expect(h.svc.open("t1", { now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(h.stripe.client.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("Stripe not configured: 503 before anything else", async () => {
    const h = make();
    (h.stripe as any).isConfigured = false;
    await expect(h.svc.open("t1", { now: NOW })).rejects.toMatchObject({ status: 503 });
    expect(h.db.locks).toHaveLength(0);
  });
});
