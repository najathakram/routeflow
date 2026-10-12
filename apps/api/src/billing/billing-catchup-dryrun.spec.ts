/**
 * SA-733r9 + r10 nits 3 and 4 - PHASE 1 rows for the dry-run the owner reads before any apply
 * (apps/api/scripts/lib/billing-catchup-core.cjs formatTenantReport). Pure: no network, no database.
 * RED = fails on master 5a938f0a2; PIN = green today.
 *
 * ASSUMPTION for phase 2: the API report JSON carries `basePriceSnapshot` as the RESOLVED plan price in DOLLARS
 * (override first, else the stored snapshot; null when none), beside `planKey` and `priceSource`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("../../scripts/lib/billing-catchup-core.cjs");

const report = (over: Record<string, unknown> = {}, stub: Record<string, unknown> = {}) => ({
  tenantId: "11111111-1111-4111-8111-111111111111",
  tenantClass: "PRODUCTION",
  tenantStatus: "ACTIVE",
  eligible: true,
  ineligible: [],
  claimState: null,
  hasStripeSubscription: false,
  externalPayment: true,
  planKey: "ENTERPRISE",
  priceSource: "override",
  monthlyCents: 10000,
  basePriceSnapshot: 100,
  rfInvoices: { open: 1, paid: 1 },
  plan: {
    ok: true,
    shape: "trial_one_time",
    paidThrough: "2026-11-11T04:08:24.000Z",
    paidFromInvoices: true,
    anchorAt: "2026-12-01T12:00:00.000Z",
    trialEndAt: "2026-12-01T12:00:00.000Z",
    stub: {
      from: "2026-11-11T04:08:24.000Z",
      to: "2026-12-01T12:00:00.000Z",
      label: "Subscription — Nov 11 to Nov 30, 2026",
      lines: [{ kind: "PLAN", code: "PLAN", cents: 6776 }],
      totalCents: 6776,
      belowStripeMinimum: false,
      ...stub,
    },
    voidInvoiceIds: [],
    unplaceableOpenIds: [],
    notes: [],
  },
  ...over,
});
const text = (r: Record<string, unknown>) => core.formatTenantReport(r).join("\n");

describe("the dry-run says, in plain words, what is charged today and when the card bills (r10 nit 4)", () => {
  it("RED: 'Charged today for Nov 11 - Dec 1; the card then bills on Dec 1.'", () => {
    expect(text(report())).toMatch(
      /Charged today for Nov 11 [-–] Dec 1; the card then bills on Dec 1\./,
    );
  });

  it("RED: a whole-month line names the span the same way (Oct 1 - Nov 1, the card bills Nov 1)", () => {
    const r = report(
      {},
      {
        from: "2026-10-01T12:00:00.000Z",
        to: "2026-11-01T12:00:00.000Z",
        totalCents: 31000,
        lines: [{ kind: "PLAN", code: "PLAN", cents: 31000 }],
      },
    );
    (r.plan as any).trialEndAt = "2026-11-01T12:00:00.000Z";
    expect(text(r)).toMatch(/Charged today for Oct 1 [-–] Nov 1; the card then bills on Nov 1\./);
  });
});

describe("the dry-run prints planKey and the resolved basePriceSnapshot (r10 nit 3)", () => {
  it("PIN: planKey is printed", () => {
    expect(text(report())).toMatch(/plan ENTERPRISE/);
  });

  it("RED: the resolved basePriceSnapshot is printed beside it ($100 override)", () => {
    expect(text(report())).toMatch(/snapshot[^\n]*\b100(\.00)?\b/i);
  });

  it("RED: an override with a NULL snapshot is flagged 'price override set but no snapshot - check before apply'", () => {
    const t = text(report({ basePriceSnapshot: null }));
    expect(t).toMatch(/price override set but no snapshot\s*[-—–]\s*check before apply/i);
  });

  it("PIN: a catalog price with no snapshot is not flagged, and an override WITH a snapshot is not flagged", () => {
    expect(text(report({ priceSource: "catalog", basePriceSnapshot: null }))).not.toMatch(
      /price override set but no snapshot/i,
    );
    expect(text(report())).not.toMatch(/price override set but no snapshot/i);
  });
});
