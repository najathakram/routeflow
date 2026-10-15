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

/** The audit rows ONE manual activation leaves: the in-tx marker (period recorded) + the post-commit trail row. */
function activationRows(
  h: { db: { audits: Record<string, unknown>[] } },
  start: string,
  end: string,
  opts: { markerPeriod?: boolean; trailPeriod?: boolean } = {},
) {
  const { markerPeriod = true, trailPeriod = true } = opts;
  const at = new Date(start);
  h.db.audits.push(
    {
      tenantId: "t1",
      entityType: "tenant",
      action: "TENANT_MANUAL_ACTIVATION_MARKER",
      createdAt: at,
      meta: markerPeriod
        ? { periodStart: at.toISOString(), periodEnd: new Date(end).toISOString() }
        : {},
    },
    {
      tenantId: "t1",
      entityType: "tenant",
      action: "TENANT_SUBSCRIPTION_ACTIVATED",
      createdAt: new Date(at.getTime() + 3000),
      meta: trailPeriod ? { periodEnd: new Date(end).toISOString() } : {},
    },
  );
}

function make(
  o: {
    sub?: Record<string, unknown>;
    tenant?: Record<string, unknown>;
    invoices?: Record<string, unknown>[];
    monthly?: number | null;
    addonLines?: any[];
    addonRows?: Record<string, unknown>[];
    invalid?: { sku: string; value: string }[];
  } = {},
) {
  const db = fakeCatchupDb({
    subs: [{ tenantId: "t1", planKey: "GROWTH", ...(o.sub ?? {}) }],
    invoices: o.invoices ?? [OCT_OPEN],
  });
  const prisma: any = {
    ...db.prisma,
    tenantAddon: { findMany: jest.fn(async () => o.addonRows ?? []) },
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
      product_data: { name: "RouteFlow Growth" },
    })),
  };
  const mutations: any = {
    checkoutAddonLines: jest.fn(async () => ({
      lineItems: o.addonLines ?? [],
      skus: (o.addonLines ?? []).map((l) => l.price_data.product_data.metadata.addonSku),
      invalid: o.invalid ?? [],
    })),
    recordInvalidCatalogAddons: jest.fn(async () => undefined),
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
      label: "October 2026 subscription",
    });
    expect(r.plan.ok && r.plan.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.eligible).toBe(true);
    expect(r.ineligible).toEqual([]);
    expect(r.rfInvoices).toEqual({ open: 1, paid: 0 });
  });

  it("October PAID => the trial shape, $0 stub, eligible (ruling 8(e): paid coverage landing exactly on an anchor 1st)", async () => {
    const r = await make({ invoices: [OCT_PAID] }).svc.plan("t1", NOW);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial" });
    expect(r.plan.ok && r.plan.stub.totalCents).toBe(0);
    expect(r.plan.ok && r.plan.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.eligible).toBe(true);
  });

  it("paid to a partial (a PAID window to Oct 5) => ELIGIBLE: S = Oct 5, the prorated line is Oct 5 -> Nov 1 (SA-733r9)", async () => {
    const partial = { ...OCT_PAID, periodEnd: new Date("2026-10-05T12:00:00Z") };
    const r = await make({ invoices: [partial] }).svc.plan("t1", NOW);
    expect(r.eligible).toBe(true);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    expect(r.plan.stub.from.toISOString()).toBe("2026-10-05T12:00:00.000Z");
    expect(r.plan.stub.totalCents).toBe(27000); // $310 x 27/31
  });

  it("PIN: through the service a prepaid shape is never STUB-bearing (a trial-with-stub / anchor_no_line-with-stub is unreachable); the stub-free 8(e) trial is reachable", async () => {
    const states: Record<string, unknown>[][] = [
      [OCT_OPEN],
      [OCT_PAID],
      [{ ...OCT_PAID, periodEnd: new Date("2026-11-14T12:00:00Z") }],
      [{ ...OCT_PAID, periodEnd: new Date("2026-10-30T12:00:00Z") }],
      [{ ...OCT_PAID, periodEnd: new Date("2026-12-01T12:00:00Z") }],
      [],
    ];
    let reachedTrial = false;
    for (const invoices of states) {
      for (const day of ["2026-10-09T10:00:00Z", "2026-10-29T04:00:00Z", "2026-10-30T09:00:00Z"]) {
        const r = await make({ invoices }).svc.plan("t1", new Date(day));
        if (!r.plan.ok) continue;
        if (r.plan.shape === "trial") {
          expect(r.plan.stub.totalCents).toBe(0);
          expect(r.plan.stub.lines).toEqual([]);
          if (r.plan.shape === "trial") reachedTrial = true;
        }
      }
    }
    expect(reachedTrial).toBe(true);
  });

  it("the add-on lines (the ones the recurring subscription will bill) are part of the stub", async () => {
    const addon = {
      price_data: { unit_amount: 3100, product_data: { metadata: { addonSku: "FORECASTING" } } },
      quantity: 2,
    };
    const h = make({
      invoices: [OCT_OPEN],
      addonLines: [addon],
      addonRows: [{ sku: "FORECASTING", addonKey: null, quantity: 2, priceSnapshot: 31 }],
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

describe("MF1 (reverse): a checkout line with no priced billable row", () => {
  it("is refused with the add-on family code - the card would charge something the invoice never billed", async () => {
    const line = {
      price_data: { unit_amount: 3100, product_data: { metadata: { addonSku: "FORECASTING" } } },
      quantity: 1,
    };
    const h = make({ invoices: [OCT_OPEN], addonLines: [line], addonRows: [] });
    const r = await h.svc.plan("t1", NOW);
    expect(r.plan).toEqual({ ok: false, reason: "checkout_addon_without_priced_row" });
    expect(catchupReportJson(r).refusals).toEqual([
      API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG,
    ]);
    const err: any = await h.svc.open("t1", { now: NOW, expectedStubCents: 34100 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG,
    });
    expect(JSON.stringify(err.getResponse())).not.toMatch(/checkout_addon_without_priced_row/);
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("MF1: add-ons the card checkout cannot bill", () => {
  const manualOcr = { sku: "OCR_PACK_250", addonKey: null, quantity: 1, priceSnapshot: 25 };
  const forecasting = {
    price_data: { unit_amount: 3100, product_data: { metadata: { addonSku: "FORECASTING" } } },
    quantity: 1,
  };

  it("plan(): a priced billable row with no checkout line is refused (coded) and listed by code, not by name", async () => {
    const h = make({ invoices: [OCT_OPEN], addonRows: [manualOcr] });
    const r = await h.svc.plan("t1", NOW);
    expect(r.plan).toEqual({ ok: false, reason: "billable_addon_not_card_billable" });
    expect(r.eligible).toBe(false);
    const json = catchupReportJson(r);
    expect(json.refusals).toEqual([API_ERROR_CODES.CATCHUP_ADDON_NOT_CARD_BILLABLE]);
    expect(JSON.stringify(json)).not.toContain("qa-acme");
    // the rows were read with the billable predicate (comps never count)
    const where = (h.prisma.tenantAddon.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", active: true, isComp: false });
  });

  it("open(): 409 CATCHUP_ADDON_NOT_CARD_BILLABLE with fixed copy (no internal reason string), no claim, no Stripe call", async () => {
    const h = make({ invoices: [OCT_OPEN], addonRows: [manualOcr] });
    const err: any = await h.svc.open("t1", { now: NOW, expectedStubCents: 31000 }).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.CATCHUP_ADDON_NOT_CARD_BILLABLE,
    });
    expect(JSON.stringify(err.getResponse())).not.toMatch(/billable_addon_not_card_billable/);
    expect(h.sub().catchupState).toBeNull();
    expect(h.db.locks).toHaveLength(0);
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("a self-serve row whose snapshot is not the catalog price: 409 CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG", async () => {
    const h = make({
      invoices: [OCT_OPEN],
      addonLines: [forecasting],
      addonRows: [{ sku: "FORECASTING", addonKey: null, quantity: 1, priceSnapshot: 29 }],
    });
    await expect(h.svc.open("t1", { now: NOW, expectedStubCents: 34100 })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_ADDON_SNAPSHOT_NOT_CATALOG },
    });
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("a matching self-serve row is eligible; the generic not-eligible 409 carries no internal reason text", async () => {
    const ok = make({
      invoices: [OCT_OPEN],
      addonLines: [forecasting],
      addonRows: [{ sku: "FORECASTING", addonKey: null, quantity: 1, priceSnapshot: 31 }],
    });
    expect((await ok.svc.plan("t1", NOW)).eligible).toBe(true);
    const h = make({ tenant: { status: "READ_ONLY" } });
    const err: any = await h.svc.open("t1", { now: NOW, expectedStubCents: 0 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE });
    expect(err.getResponse().message).not.toMatch(/tenant_not_active/);
  });
});

describe("MF2 -> SA-733r9: paid coverage is one walk over every paid source (activations AND PAID invoices)", () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    periodStart: new Date("2026-10-01T12:00:00Z"),
    periodEnd: new Date("2026-11-01T12:00:00Z"),
    ...over,
  });

  it("activated Sep 10 for 30 days ([Sep 10, Oct 10)): ELIGIBLE - the line starts at Oct 10; open() sends it with the coded fields", async () => {
    const h = make({ invoices: [OCT_OPEN], sub: sub() });
    activationRows(h, "2026-09-10T09:00:00Z", "2026-10-10T09:00:00Z");
    const r = await h.svc.plan("t1", NOW);
    expect(r.eligible).toBe(true);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    expect(r.plan.stub.from.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    const json = catchupReportJson(r);
    expect(json.subPeriod).toEqual({
      start: "2026-10-01T12:00:00.000Z",
      end: "2026-11-01T12:00:00.000Z",
    });
    await h.svc.open("t1", { now: NOW, expectedStubCents: r.plan.stub.totalCents });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.metadata.catchup_from).toBe("2026-10-10T09:00:00.000Z");
    expect(h.sub().catchupState).toBe("SESSION_OPEN");
  });

  it("F1: the catch-up session says Managed Payments is OFF and never enables automatic tax", async () => {
    const h = make({ invoices: [OCT_OPEN], sub: sub() });
    activationRows(h, "2026-09-10T09:00:00Z", "2026-10-10T09:00:00Z");
    const r = await h.svc.plan("t1", NOW);
    if (!r.plan.ok) throw new Error("plan not ok");
    await h.svc.open("t1", { now: NOW, expectedStubCents: r.plan.stub.totalCents });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.managed_payments).toEqual({ enabled: false });
    expect(params.automatic_tax?.enabled).not.toBe(true);
  });

  it("activated Sep 26 ([Sep 26, Oct 26)): eligible before AND after the next window is issued (S = Oct 26)", async () => {
    const nextWindow = {
      ...OCT_OPEN,
      id: "next",
      periodKey: "kn",
      periodStart: new Date("2026-10-26T09:00:00Z"),
      periodEnd: new Date("2026-11-01T12:00:00Z"),
    };
    for (const invoices of [[], [nextWindow]]) {
      const h = make({ invoices });
      activationRows(h, "2026-09-26T09:00:00Z", "2026-10-26T09:00:00Z");
      const r = await h.svc.plan("t1", NOW);
      expect(r.eligible).toBe(true);
      expect(r.plan.ok && r.plan.stub.from.toISOString()).toBe("2026-10-26T09:00:00.000Z");
    }
  });

  it("a renewal on Oct 5 after an activation that ended Sep 1 leaves Sep 1..Oct 5 unpaid: NEEDS RULING (paid_after_gap)", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z");
    activationRows(h, "2026-10-05T09:00:00Z", "2026-11-04T09:00:00Z");
    const r = await h.svc.plan("t1", NOW);
    expect(r.plan).toEqual({ ok: false, reason: "paid_after_gap" });
    expect(catchupReportJson(r).refusals).toEqual([API_ERROR_CODES.CATCHUP_NEEDS_RULING]);
  });

  it("a PAID RfInvoice window reaching Oct 5 is paid coverage: eligible, S = Oct 5", async () => {
    const paid = {
      ...OCT_PAID,
      id: "p",
      periodKey: "kp",
      periodStart: new Date("2026-09-05T12:00:00Z"),
      periodEnd: new Date("2026-10-05T12:00:00Z"),
    };
    const h = make({ invoices: [paid, OCT_OPEN] });
    const r = await h.svc.plan("t1", NOW);
    expect(r.eligible).toBe(true);
    expect(r.plan.ok && r.plan.stub.from.toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });

  it("the normal unpaid-October tenant stays ELIGIBLE (Sept paid through Oct 1, October only an OPEN requirement, activated in August)", async () => {
    const sepPaid = {
      ...OCT_PAID,
      id: "sep",
      periodKey: "ks",
      periodStart: new Date("2026-09-01T12:00:00Z"),
      periodEnd: new Date("2026-10-01T12:00:00Z"),
    };
    const h = make({ invoices: [sepPaid, OCT_OPEN], sub: sub() });
    activationRows(h, "2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z");
    const r = await h.svc.plan("t1", NOW);
    expect(r.eligible).toBe(true);
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    expect(catchupReportJson(r).subPeriod).toEqual({
      start: "2026-10-01T12:00:00.000Z",
      end: "2026-11-01T12:00:00.000Z",
    });
  });

  it("a legacy activation (no recorded period on either row) is refused and LISTED by tenant id with its reason, no names", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z", {
      markerPeriod: false,
      trailPeriod: false,
    });
    const r = await h.svc.plan("t1", NOW);
    expect(r.plan).toEqual({ ok: false, reason: "manual_marker_without_period" });
    expect(r.eligible).toBe(false);
    const json = catchupReportJson(r);
    expect(json.ineligible).toContain("manual_marker_without_period");
    expect(json.refusals).toEqual([API_ERROR_CODES.CATCHUP_MANUAL_PERIOD_AHEAD]);
    expect(JSON.stringify(json)).not.toContain("qa-acme");
    // the census carries it too
    h.prisma.tenantSubscription = {
      ...h.prisma.tenantSubscription,
      findMany: jest.fn(async () => [{ tenantId: "t1" }]),
    };
    const c = await h.svc.census(NOW);
    expect(c.tenants[0]).toMatchObject({
      tenantId: "t1",
      eligible: false,
      ineligible: expect.arrayContaining(["manual_marker_without_period"]),
    });
    expect(JSON.stringify(c)).not.toContain("qa-acme");
  });

  it("the period only on the trail row (or only on the marker) is a recorded period: eligible when it ended before the start", async () => {
    for (const opts of [{ markerPeriod: false }, { trailPeriod: false }]) {
      const h = make({ invoices: [OCT_OPEN] });
      activationRows(h, "2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z", opts);
      expect((await h.svc.plan("t1", NOW)).eligible).toBe(true);
    }
  });

  it("nothing left to cover (paid coverage ends exactly at the first charged service start): unchanged, eligible, planned from the go-live boundary", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-09-01T12:00:00Z", "2026-10-01T12:00:00Z");
    const r = await h.svc.plan("t1", NOW);
    expect(r.eligible).toBe(true);
    expect(r.plan.ok && r.plan.stub.from.toISOString()).toBe("2026-10-01T12:00:00.000Z");
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
    expect(c.counts).toMatchObject({
      total: 2,
      planned: 1,
      failed: 1,
      eligible: 1,
      trialOneTime: 1,
    });
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
    const out = await h.svc.open("t1", { now: NOW, expectedStubCents: 31000 });
    expect(heldAtCreate[0]).toMatchObject({ catchupState: "SESSION_OPEN", catchupSessionId: null });
    expect(out).toMatchObject({ sessionId: "cs_new", shape: "trial_one_time", stubCents: 31000 });
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
    const err: any = await h.svc.open("t1", { now: NOW, expectedStubCents: 31000 }).catch((e) => e);
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

  it("ruling item 8(e): a tenant who ALREADY PAID October gets the trial shape - no one-time line, the trial ends Nov 1, the card bills from then", async () => {
    const h = make({ invoices: [OCT_PAID] });
    const out = await h.svc.open("t1", { now: NOW, expectedStubCents: 0 });
    expect(out).toMatchObject({ shape: "trial", stubCents: 0 });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.line_items.filter((l: any) => !l.price_data.recurring)).toHaveLength(0);
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.metadata.catchup_from).toBe("2026-11-01T12:00:00.000Z"); // MF-B: S === A, both keys
    expect(params.metadata.catchup_to).toBe("2026-11-01T12:00:00.000Z");
  });

  it("a PAID window to a partial (Oct 5): the open succeeds with the prorated line (27/31), trial_end = Nov 1, catchup_from = Oct 5", async () => {
    const h = make({ invoices: [{ ...OCT_PAID, periodEnd: new Date("2026-10-05T12:00:00Z") }] });
    const out = await h.svc.open("t1", { now: NOW, expectedStubCents: 27000 });
    expect(out).toMatchObject({ shape: "trial_one_time", stubCents: 27000 });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.metadata.catchup_from).toBe("2026-10-05T12:00:00.000Z");
    expect(params.metadata.catchup_to).toBe("2026-11-01T12:00:00.000Z");
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
    await expect(h.svc.open("t1", { now: NOW, expectedStubCents: 0 })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_NEEDS_RULING },
    });
    expect(h.sub().catchupState).toBeNull();
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("a tenant that already has a Stripe subscription is NEEDS RULING (census), before anything is written", async () => {
    const h = make({ sub: { stripeSubId: "sub_x" } });
    await expect(h.svc.open("t1", { now: NOW, expectedStubCents: 0 })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_NEEDS_RULING },
    });
    expect(h.db.locks).toHaveLength(0);
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("an amount that moved since the dry-run: 409 CATCHUP_AMOUNT_CHANGED, nothing created", async () => {
    const h = make();
    await expect(h.svc.open("t1", { now: NOW, expectedStubCents: 999 })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_AMOUNT_CHANGED },
    });
    expect(h.sub().catchupState).toBeNull();
  });

  it("a second open while a claim is held is refused (exactly one session per tenant)", async () => {
    const h = make();
    await h.svc.open("t1", { now: NOW, expectedStubCents: 31000 });
    await expect(h.svc.open("t1", { now: NOW, expectedStubCents: 31000 })).rejects.toMatchObject({
      status: 409,
    });
    expect(h.stripe.client.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("Stripe not configured: 503 before anything else", async () => {
    const h = make();
    (h.stripe as any).isConfigured = false;
    await expect(h.svc.open("t1", { now: NOW, expectedStubCents: 0 })).rejects.toMatchObject({
      status: 503,
    });
    expect(h.db.locks).toHaveLength(0);
  });
});

describe("Opus review: planning under the claim, the plan key, billing start", () => {
  it("SHOULD-FIX 3: staff recorded a cheque BETWEEN the dry-run read and the claim -> re-plan under the claim, abort, create nothing", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    const realFind = h.prisma.rfInvoice.findMany;
    let calls = 0;
    h.prisma.rfInvoice.findMany = jest.fn(async (a: any) => {
      calls += 1;
      // the 2nd read (after the claim was taken) sees October PAID: the unpaid span (and the stub) changed
      return calls >= 2 ? [{ ...OCT_PAID, id: "inv_oct_open" }] : realFind(a);
    });
    await expect(h.svc.open("t1", { now: NOW, expectedStubCents: 31000 })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_AMOUNT_CHANGED },
    });
    expect(h.sub().catchupState).toBeNull(); // the claim was dropped
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("the re-plan under the claim does not refuse its own claim (claim_held is not a reason against itself)", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    const out = await h.svc.open("t1", { now: NOW, expectedStubCents: 31000 });
    expect(out.sessionId).toBeTruthy();
  });

  it("SHOULD-FIX 4: the session carries the RESOLVED plan key, never a STARTER fallback (a row with a null planKey)", async () => {
    const h = make({ sub: { planKey: null }, invoices: [OCT_OPEN] });
    h.pricing.resolveTenantPricing.mockResolvedValue({
      planKey: "SCALE",
      monthly: 310,
      source: "override",
      currency: "usd",
    });
    await h.svc.open("t1", { now: NOW, expectedStubCents: 31000 });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.metadata.planKey).toBe("SCALE");
  });

  it("SA-733r9 rule 6: a tenant activated AFTER go-live is eligible on the same rules (activated_after_go_live is retired) - billed from its first activation", async () => {
    const h = make({ invoices: [] });
    activationRows(h, "2026-10-20T08:30:00Z", "2026-11-19T08:30:00Z");
    const r = await h.svc.plan("t1", NOW);
    expect(r.ineligible).toEqual([]);
    expect(r.eligible).toBe(true);
    expect(r.plan.ok && r.plan.stub.from.toISOString()).toBe("2026-11-19T08:30:00.000Z");
  });

  it("a tenant activated before go-live (its period ended before Oct 1) is unaffected", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activationRows(h, "2026-08-02T00:00:00Z", "2026-09-01T00:00:00Z");
    const r = await h.svc.plan("t1", NOW);
    expect(r.eligible).toBe(true);
    expect(r.plan.ok && r.plan.stub.from.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("nit: an OPEN RfInvoice with no period is NEEDS RULING (the tenant is not plainly eligible)", async () => {
    const h = make({
      invoices: [{ ...OCT_OPEN, id: "x", periodStart: null, periodEnd: null, periodKey: "kx" }],
    });
    const r = await h.svc.plan("t1", NOW);
    expect(r.eligible).toBe(false);
    expect(r.ineligible).toContain("unplaceable_open_invoice");
  });
});

describe("B1102 a held add-on with an unparseable catalog includedAtPlan", () => {
  const INVALID = [{ sku: "FORECASTING", value: "pro_typo" }];
  const held = [{ sku: "FORECASTING", quantity: 1, priceSnapshot: 19 }];

  it("the dry-run reports it as addon_catalog_invalid with the catalog code, not 'not card billable', and writes nothing", async () => {
    const h = make({ invalid: INVALID, addonRows: held });
    const r = await h.svc.plan("t1", NOW);
    expect(r.eligible).toBe(false);
    expect(r.ineligible).toContain("addon_catalog_invalid");
    expect(catchupReportJson(r).refusals).toContain(API_ERROR_CODES.ADDON_CATALOG_INVALID);
    expect(h.mutations.recordInvalidCatalogAddons).not.toHaveBeenCalled();
    expect(h.db.audits).toHaveLength(0);
  });

  it("open() writes the catalog-invalid notice and answers ADDON_CATALOG_INVALID, with the claim untouched and zero Stripe calls", async () => {
    const h = make({ invalid: INVALID, addonRows: held });
    const err: any = await h.svc.open("t1", { now: NOW, expectedStubCents: 31000 }).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.ADDON_CATALOG_INVALID,
      reason: "CATALOG_INVALID",
      sku: "FORECASTING",
    });
    expect(h.mutations.recordInvalidCatalogAddons).toHaveBeenCalledWith("t1", INVALID);
    expect(h.stripe.calls).toEqual([]);
    expect(h.sub().catchupState).toBeNull();
  });
});
