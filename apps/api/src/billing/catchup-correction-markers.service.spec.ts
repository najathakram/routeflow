import { CatchupCheckoutService, catchupReportJson } from "./catchup-checkout.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup } from "../testing/fake-stripe-catchup";

/**
 * SA-733r11 (row 385) - PHASE 1 red rows: the append-only CORRECTION MARKERS the catch-up reads beside the manual
 * activation markers.
 *   TENANT_MANUAL_ACTIVATION_COVERAGE_VOID  { voidsMarkerId, reason, actor, ownerApprovedAt }  - the voided
 *       activation's window is NOT paid coverage (the activation still happened as an event).
 *   TENANT_BILLING_START_OVERRIDE           { billingStart, reason, actor, ownerApprovedAt }   - floor =
 *       max(go-live, billingStart), REPLACING the first-activation term; the latest row wins; billingStart must be an
 *       anchor 1st 12:00Z and >= go-live (Oct 1 12:00Z).
 * Through `CatchupCheckoutService.plan()/open()` over the in-memory store (no network). RED = fails on master
 * 5a938f0a2 (the markers are unknown there); PIN = green today.
 *
 * ASSUMPTIONS for phase 2: the audit row `id` of an activation MARKER is what `voidsMarkerId` names (the fake store
 * returns whatever columns the service selects, so the read must select `id`); the refusal for a bad billingStart is
 * listed in `ineligible` with a reason containing `billing_start`.
 */
const d = (iso: string) => new Date(iso);
const T = "t1";
const VOID_ACTION = "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID";
const OVERRIDE_ACTION = "TENANT_BILLING_START_OVERRIDE";
const RESTORE_ACTION = "TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE";

const OCT_OPEN = {
  id: "inv_oct_open",
  tenantId: T,
  status: "OPEN",
  number: "RF-1",
  periodStart: d("2026-10-01T12:00:00Z"),
  periodEnd: d("2026-11-01T12:00:00Z"),
  periodKey: "k-oct",
};
const NOV_OPEN = {
  ...OCT_OPEN,
  id: "inv_nov_open",
  periodStart: d("2026-11-01T12:00:00Z"),
  periodEnd: d("2026-12-01T12:00:00Z"),
  periodKey: "k-nov",
};

type Audits = { db: { audits: Record<string, unknown>[] } };

/** One manual activation: the marker (id `markerId`, with the recorded period) + the post-commit trail row. */
function activation(h: Audits, markerId: string, start: string, end: string) {
  h.db.audits.push(
    {
      id: markerId,
      tenantId: T,
      entityType: ADMIN_AUDIT_ENTITY,
      action: "TENANT_MANUAL_ACTIVATION_MARKER",
      createdAt: d(start),
      meta: { periodStart: d(start).toISOString(), periodEnd: d(end).toISOString() },
    },
    {
      id: `${markerId}-trail`,
      tenantId: T,
      entityType: ADMIN_AUDIT_ENTITY,
      action: "TENANT_SUBSCRIPTION_ACTIVATED",
      createdAt: new Date(d(start).getTime() + 3000),
      meta: { periodEnd: d(end).toISOString() },
    },
  );
}
function voidMarker(h: Audits, voidsMarkerId: string, at = "2026-10-13T08:00:00Z") {
  h.db.audits.push({
    id: `void-${voidsMarkerId}`,
    tenantId: T,
    entityType: ADMIN_AUDIT_ENTITY,
    action: VOID_ACTION,
    createdAt: d(at),
    meta: {
      voidsMarkerId,
      reason: "owner states nothing was paid",
      actor: "sa-1",
      ownerApprovedAt: "2026-10-13T07:55:00.000Z",
    },
  });
}
/** SA-733r12: a RESTORE names the same activation marker id as a VOID and undoes it (append-only). */
function restoreMarker(
  h: Audits,
  restoresMarkerId: string,
  at = "2026-10-13T09:00:00Z",
  id = `restore-${restoresMarkerId}-${at}`,
) {
  h.db.audits.push({
    id,
    tenantId: T,
    entityType: ADMIN_AUDIT_ENTITY,
    action: RESTORE_ACTION,
    createdAt: d(at),
    meta: {
      restoresMarkerId,
      reason: "the payment was found after all",
      actor: "sa-1",
      ownerApprovedAt: "2026-10-13T08:55:00.000Z",
    },
  });
}
function billingStart(h: Audits, start: string, at = "2026-10-13T08:05:00Z", id = `bs-${at}`) {
  h.db.audits.push({
    id,
    tenantId: T,
    entityType: ADMIN_AUDIT_ENTITY,
    action: OVERRIDE_ACTION,
    createdAt: d(at),
    meta: {
      billingStart: start,
      reason: "owner rule: billing starts Oct 1",
      actor: "sa-1",
      ownerApprovedAt: "2026-10-13T07:55:00.000Z",
    },
  });
}

function make(o: { monthly?: number; invoices?: Record<string, unknown>[] } = {}) {
  const db = fakeCatchupDb({
    subs: [{ tenantId: T, planKey: "ENTERPRISE" }],
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
  const stripe = fakeStripeCatchup();
  const monthly = o.monthly ?? 100;
  const pricing: any = {
    resolveTenantPricing: jest.fn(async () => ({
      planKey: "ENTERPRISE",
      monthly,
      source: "override",
      currency: "usd",
    })),
    checkoutPriceData: jest.fn(async () => ({
      currency: "usd",
      unit_amount: monthly * 100,
      recurring: { interval: "month" },
      product_data: { name: "RouteFlow Enterprise - monthly" },
    })),
  };
  const mutations: any = { checkoutAddonLines: jest.fn(async () => ({ lineItems: [], skus: [] })) };
  const claim = new CatchupClaimService(prisma, stripe as any, { emit: jest.fn() } as any);
  const billing: any = { ensureStripeCustomer: jest.fn(async () => "cus_1") };
  const svc = new CatchupCheckoutService(prisma, stripe as any, pricing, mutations, claim, billing);
  return { svc, db, stripe, prisma };
}

describe("the new audit action codes are declared", () => {
  it("RED: AdminAuditAction carries TENANT_MANUAL_ACTIVATION_COVERAGE_VOID and TENANT_BILLING_START_OVERRIDE", () => {
    expect(
      (AdminAuditAction as Record<string, string>).TENANT_MANUAL_ACTIVATION_COVERAGE_VOID,
    ).toBe(VOID_ACTION);
    expect((AdminAuditAction as Record<string, string>).TENANT_BILLING_START_OVERRIDE).toBe(
      OVERRIDE_ACTION,
    );
    expect(
      (AdminAuditAction as Record<string, string>).TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE,
    ).toBe(RESTORE_ACTION);
  });
});

describe("RED: a coverage-void marker removes an activation window from the paid-coverage walk", () => {
  it("activation [Oct 12, Nov 11) voided: it is NOT paid coverage - the plan no longer reads 'paid to Nov 11' (master / r10: S = Nov 11)", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activation(h, "m_act1", "2026-10-12T04:08:24Z", "2026-11-11T04:08:24Z");
    voidMarker(h, "m_act1");
    const r = await h.svc.plan(T, d("2026-10-13T10:00:00Z"));
    expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
    if (!r.plan.ok) return;
    // a VOIDED activation still supplies the floor's first-activation term (the activation happened as an event;
    // only its coverage is void): with nothing else paid, S is that activation's own period start
    expect(r.plan.stub.from.toISOString()).toBe("2026-10-12T04:08:24.000Z");
    expect(r.plan.stub.totalCents).toBeGreaterThan(0);
  });

  it("PIN: a void naming a marker id that does not exist changes nothing (the activation still counts)", async () => {
    const h = make({ invoices: [] });
    activation(h, "m_act1", "2026-09-01T12:00:00Z", "2026-11-01T12:00:00Z");
    voidMarker(h, "m_other");
    const r = await h.svc.plan(T, d("2026-10-13T10:00:00Z"));
    expect(r.plan).toMatchObject({ ok: true, shape: "trial" });
    expect(r.plan.ok && r.plan.stub.from.toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });
});

describe("RED: a billing-start override sets the floor (replacing the first-activation term)", () => {
  const pilot = () => {
    const h = make({ monthly: 100, invoices: [OCT_OPEN, NOV_OPEN] });
    activation(h, "m_act1", "2026-10-12T04:08:24Z", "2026-11-11T04:08:24Z");
    voidMarker(h, "m_act1");
    billingStart(h, "2026-10-01T12:00:00.000Z");
    return h;
  };

  it.each(["2026-10-13T10:00:00Z", "2026-10-20T10:00:00Z", "2026-10-28T10:00:00Z"])(
    "the pilot tenant (billingStart Oct 1 12:00Z, voided first activation Oct 12), session %s: S = Oct 1 12:00Z, A = Nov 1 12:00Z, stub $100.00 (31/31), trial_end Nov 1",
    async (day) => {
      const r = await pilot().svc.plan(T, d(day));
      expect(r.ineligible).toEqual([]);
      expect(r.plan).toMatchObject({ ok: true, shape: "trial_one_time" });
      if (!r.plan.ok) return;
      expect(r.plan.stub.from.toISOString()).toBe("2026-10-01T12:00:00.000Z");
      expect(r.plan.stub.to.toISOString()).toBe("2026-11-01T12:00:00.000Z");
      expect(r.plan.stub.totalCents).toBe(10000);
      expect(r.plan.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
      // settle voids every OPEN RfInvoice whose snapped end is after Oct 1
      expect(r.plan.voidInvoiceIds.sort()).toEqual(["inv_nov_open", "inv_oct_open"]);
    },
  );

  it("... and open() sends it: one $100.00 one-time line, trial_end Nov 1, catchup_from Oct 1 12:00Z, catchup_to Nov 1 12:00Z", async () => {
    const h = pilot();
    const out = await h.svc.open(T, { now: d("2026-10-13T10:00:00Z"), expectedStubCents: 10000 });
    expect(out).toMatchObject({ shape: "trial_one_time", stubCents: 10000 });
    const params = h.stripe.client.checkout.sessions.create.mock.calls[0][0];
    expect(params.subscription_data.trial_end).toBe(Date.UTC(2026, 10, 1, 12) / 1000);
    expect(params.metadata.catchup_from).toBe("2026-10-01T12:00:00.000Z");
    expect(params.metadata.catchup_to).toBe("2026-11-01T12:00:00.000Z");
  });

  it("the override REPLACES the first-activation term: a later billingStart (Nov 1 12:00Z) moves the floor and S past it - no line, the stub-free trial", async () => {
    const h = make({ monthly: 100, invoices: [] });
    billingStart(h, "2026-11-01T12:00:00.000Z");
    const r = await h.svc.plan(T, d("2026-10-13T10:00:00Z"));
    expect(r.plan).toMatchObject({ ok: true, shape: "trial" });
    if (!r.plan.ok) return;
    expect(r.plan.stub.from.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(r.plan.stub.totalCents).toBe(0);
  });

  it("the LATEST override row wins and every override is append-only: Oct 1 then Nov 1 -> Nov 1; Nov 1 then Oct 1 -> Oct 1", async () => {
    const a = make({ monthly: 100, invoices: [] });
    billingStart(a, "2026-10-01T12:00:00.000Z", "2026-10-13T08:00:00Z", "bs-1");
    billingStart(a, "2026-11-01T12:00:00.000Z", "2026-10-13T09:00:00Z", "bs-2");
    const ra = await a.svc.plan(T, d("2026-10-13T10:00:00Z"));
    expect(ra.plan.ok && ra.plan.stub.from.toISOString()).toBe("2026-11-01T12:00:00.000Z");

    const b = make({ monthly: 100, invoices: [] });
    billingStart(b, "2026-11-01T12:00:00.000Z", "2026-10-13T08:00:00Z", "bs-1");
    billingStart(b, "2026-10-01T12:00:00.000Z", "2026-10-13T09:00:00Z", "bs-2");
    const rb = await b.svc.plan(T, d("2026-10-13T10:00:00Z"));
    expect(rb.plan.ok && rb.plan.stub.from.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(rb.plan.ok && rb.plan.stub.totalCents).toBe(10000);
  });
});

describe("RED: an invalid billingStart is refused (anchor 1st at 12:00Z and >= go-live)", () => {
  it.each([
    ["not a 1st", "2026-10-15T12:00:00.000Z"],
    ["a 1st at 00:00Z, not 12:00Z", "2026-11-01T00:00:00.000Z"],
    ["before go-live", "2026-09-01T12:00:00.000Z"],
    ["unparseable", "next tuesday"],
  ])("%s (%s): ineligible, billing_start named, nothing claimed or sent", async (_n, start) => {
    const h = make({ invoices: [OCT_OPEN] });
    billingStart(h, start);
    const r = await h.svc.plan(T, d("2026-10-13T10:00:00Z"));
    expect(r.eligible).toBe(false);
    expect(JSON.stringify([r.ineligible, r.plan])).toMatch(/billing_start/);
    await expect(
      h.svc.open(T, { now: d("2026-10-13T10:00:00Z"), expectedStubCents: 10000 }),
    ).rejects.toBeDefined();
    expect(h.stripe.client.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("N5: a voided activation with NO recorded period still supplies its earliest `at` as the floor's first-activation term", () => {
  it("activation marker + trail with no period on either row, voided: the floor is that activation's own instant, not go-live", async () => {
    const h = make({ monthly: 100, invoices: [OCT_OPEN] });
    const at = d("2026-10-15T09:00:00Z");
    h.db.audits.push(
      {
        id: "m_legacy",
        tenantId: T,
        entityType: ADMIN_AUDIT_ENTITY,
        action: "TENANT_MANUAL_ACTIVATION_MARKER",
        createdAt: at,
        meta: {},
      },
      {
        id: "m_legacy-trail",
        tenantId: T,
        entityType: ADMIN_AUDIT_ENTITY,
        action: "TENANT_SUBSCRIPTION_ACTIVATED",
        createdAt: new Date(at.getTime() + 3000),
        meta: {},
      },
    );
    voidMarker(h, "m_legacy");
    const r = await h.svc.plan(T, d("2026-10-20T10:00:00Z"));
    expect(r.plan).toMatchObject({ ok: true });
    if (!r.plan.ok) return;
    expect(r.plan.stub.from.toISOString()).toBe("2026-10-15T09:00:00.000Z");
  });
});

describe("N10: the report and dry-run JSON show the floor, the active billing-start override and the marker states", () => {
  it("floor, its source and the override are in the JSON; a voided / restored marker is labelled", async () => {
    const h = make({ monthly: 100, invoices: [OCT_OPEN] });
    activation(h, "m_act1", "2026-10-12T04:08:24Z", "2026-11-11T04:08:24Z");
    voidMarker(h, "m_act1", "2026-10-13T08:00:00Z");
    billingStart(h, "2026-10-01T12:00:00.000Z");
    const json = catchupReportJson(await h.svc.plan(T, d("2026-10-13T10:00:00Z"))) as any;
    expect(json.plan.floor).toBe("2026-10-01T12:00:00.000Z");
    expect(json.plan.floorSource).toBe("billing_start_override");
    expect(json.billingStartOverride).toEqual({
      billingStart: "2026-10-01T12:00:00.000Z",
      valid: true,
    });
    expect(json.markers).toEqual([expect.objectContaining({ id: "m_act1", state: "voided" })]);

    const g = make({ monthly: 100, invoices: [OCT_OPEN] });
    activation(g, "m_act1", "2026-09-20T12:00:00Z", "2026-11-01T12:00:00Z");
    voidMarker(g, "m_act1", "2026-10-13T08:00:00Z");
    restoreMarker(g, "m_act1", "2026-10-13T09:00:00Z");
    const j2 = catchupReportJson(await g.svc.plan(T, d("2026-10-13T10:00:00Z"))) as any;
    expect(j2.billingStartOverride).toBeNull();
    expect(j2.plan.floorSource).toBe("go_live");
    expect(j2.markers[0]).toMatchObject({ id: "m_act1", state: "restored" });
  });
});

describe("RED (SA-733r12): per activation marker the LATEST void / restore wins", () => {
  // activation [Sep 20, Nov 1 12:00): it starts before go-live, so the floor is go-live whatever the void says;
  // counted => paidThrough Nov 1 (S = A, the stub-free trial); ignored => paidThrough = floor (S = Oct 1, $100).
  const setup = (...steps: ((h: Audits) => void)[]) => {
    const h = make({ monthly: 100, invoices: [OCT_OPEN] });
    activation(h, "m_act1", "2026-09-20T12:00:00Z", "2026-11-01T12:00:00Z");
    for (const step of steps) step(h);
    return h;
  };
  const NOW = d("2026-10-13T10:00:00Z");
  const counts = async (h: ReturnType<typeof setup>) => {
    const r = await h.svc.plan(T, NOW);
    expect(r.plan.ok).toBe(true);
    if (!r.plan.ok) throw new Error("unreachable");
    return r.plan.stub.from.toISOString() === "2026-11-01T12:00:00.000Z";
  };
  const V = (at: string, id?: string) => (h: Audits) => {
    voidMarker(h, "m_act1", at);
    if (id) h.db.audits[h.db.audits.length - 1].id = id;
  };
  const R = (at: string, id?: string) => (h: Audits) => restoreMarker(h, "m_act1", at, id);

  it("PIN: no marker row - the activation counts as paid coverage (paidThrough Nov 1)", async () => {
    expect(await counts(setup())).toBe(true);
  });

  it("RED: VOID -> ignored (paidThrough = floor, S = Oct 1)", async () => {
    expect(await counts(setup(V("2026-10-13T08:00:00Z")))).toBe(false);
  });

  it("PIN (green on master - master ignores every marker; these bite only beside the VOID rows): VOID then RESTORE -> counts again (paidThrough Nov 1)", async () => {
    expect(await counts(setup(V("2026-10-13T08:00:00Z"), R("2026-10-13T09:00:00Z")))).toBe(true);
  });

  it("RED: VOID, RESTORE, then a second VOID -> ignored again", async () => {
    expect(
      await counts(
        setup(V("2026-10-13T08:00:00Z"), R("2026-10-13T09:00:00Z"), V("2026-10-13T10:00:00Z")),
      ),
    ).toBe(false);
  });

  it("PIN (green on master - master ignores every marker; these bite only beside the VOID rows): a RESTORE with no VOID before it changes nothing (counts)", async () => {
    expect(await counts(setup(R("2026-10-13T09:00:00Z")))).toBe(true);
  });

  it("PIN (green on master - master ignores every marker; these bite only beside the VOID rows): the order is by createdAt, not insertion order (a RESTORE inserted FIRST but dated LAST wins)", async () => {
    expect(await counts(setup(R("2026-10-13T10:00:00Z"), V("2026-10-13T08:00:00Z")))).toBe(true);
  });

  it("same-createdAt ties resolve deterministically by id (determinism only: uuid ids carry no time order, and parseArgs forbids void + restore of one marker in one run)", async () => {
    const at = "2026-10-13T09:00:00Z";
    expect(await counts(setup(V(at, "row-a"), R(at, "row-b")))).toBe(true); // restore has the greater id
    expect(await counts(setup(V(at, "row-b"), R(at, "row-a")))).toBe(false); // void has the greater id
  });

  it("a RESTORE names ONE marker: restoring another marker id does not undo this VOID", async () => {
    const h = setup(V("2026-10-13T08:00:00Z"));
    restoreMarker(h, "m_other", "2026-10-13T09:00:00Z");
    expect(await counts(h)).toBe(false);
  });

  it("PIN: every VOID and RESTORE row remains after planning (append-only, never edited or deleted)", async () => {
    const h = setup(
      V("2026-10-13T08:00:00Z"),
      R("2026-10-13T09:00:00Z"),
      V("2026-10-13T10:00:00Z"),
    );
    const before = JSON.stringify(h.db.audits);
    await h.svc.plan(T, NOW);
    expect(JSON.stringify(h.db.audits)).toBe(before);
    expect(h.db.audits.filter((a) => a.action === VOID_ACTION)).toHaveLength(2);
    expect(h.db.audits.filter((a) => a.action === RESTORE_ACTION)).toHaveLength(1);
  });
});

describe("the marker read (catchup-checkout.service.ts): ONE query for all three marker kinds", () => {
  it("RED: exactly one auditLog.findMany reads TENANT_MANUAL_ACTIVATION_MARKER, TENANT_SUBSCRIPTION_ACTIVATED, the COVERAGE_VOID, the COVERAGE_RESTORE and the BILLING_START_OVERRIDE actions together", async () => {
    const h = make();
    await h.svc.plan(T, d("2026-10-13T10:00:00Z"));
    const calls = (h.prisma.auditLog.findMany as jest.Mock).mock.calls.map((c) => c[0]);
    const markerReads = calls.filter((a) =>
      (a?.where?.action?.in ?? []).includes("TENANT_MANUAL_ACTIVATION_MARKER"),
    );
    expect(markerReads).toHaveLength(1);
    expect(markerReads[0].where.action.in).toEqual(
      expect.arrayContaining([
        "TENANT_MANUAL_ACTIVATION_MARKER",
        "TENANT_SUBSCRIPTION_ACTIVATED",
        VOID_ACTION,
        RESTORE_ACTION,
        OVERRIDE_ACTION,
      ]),
    );
    expect(markerReads[0].where).toMatchObject({ tenantId: T, entityType: ADMIN_AUDIT_ENTITY });
    // the row id is selected (a void names a marker by its id)
    expect(markerReads[0].select).toMatchObject({ id: true });
  });
});

describe("PIN: the markers are append-only", () => {
  it("planning reads the original activation rows and writes NOTHING: the marker and trail rows are byte-identical afterwards", async () => {
    const h = make({ invoices: [OCT_OPEN] });
    activation(h, "m_act1", "2026-10-12T04:08:24Z", "2026-11-11T04:08:24Z");
    voidMarker(h, "m_act1");
    billingStart(h, "2026-10-01T12:00:00.000Z");
    const before = JSON.stringify(h.db.audits);
    const r = await h.svc.plan(T, d("2026-10-13T10:00:00Z"));
    expect(catchupReportJson(r).tenantId).toBe(T);
    expect(JSON.stringify(h.db.audits)).toBe(before);
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
