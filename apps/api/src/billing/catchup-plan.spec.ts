import * as fs from "fs";
import * as path from "path";
import {
  CATCHUP_GO_LIVE,
  activationClusters,
  type ActivationRecord,
  addonCardRefusal,
  catchupShape,
  firstBoundaryNotBefore,
  paidThroughOf,
  planCatchup,
  stubLines,
  type CatchupInvoice,
} from "./catchup-plan";

const d = (iso: string) => new Date(iso);
const inv = (
  id: string,
  status: string,
  start: string | null,
  end: string | null,
): CatchupInvoice => ({
  id,
  status,
  periodStart: start ? d(start) : null,
  periodEnd: end ? d(end) : null,
});
const OCT = (status: string, id = "oct") =>
  inv(id, status, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
const NOW = d("2026-10-09T10:00:00Z");
const plan = (over: Partial<Parameters<typeof planCatchup>[0]> = {}) => {
  const p = planCatchup({ now: NOW, monthly: 310, addons: [], invoices: [], ...over });
  if (!p.ok) throw new Error(`plan refused: ${p.reason}`);
  return p;
};

describe("one helper (L-167): snap, boundary and contiguity come from rf-invoice/calendar-windows", () => {
  it("catchup-plan.ts defines no snap / contiguity / boundary helper of its own", () => {
    const src = fs.readFileSync(path.join(__dirname, "catchup-plan.ts"), "utf8");
    expect(src).toContain('from "./rf-invoice/calendar-windows"');
    expect(src).not.toMatch(/function (snapToBoundary|isContiguous|nearestBoundary)/);
    expect(src).not.toMatch(/export (const|function) boundary/);
  });

  it("firstBoundaryNotBefore is exact (no snapping): 'at least 72 h from now'", () => {
    expect(firstBoundaryNotBefore(d("2026-11-01T12:00:00Z")).toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    expect(firstBoundaryNotBefore(d("2026-11-01T12:00:01Z")).toISOString()).toBe(
      "2026-12-01T12:00:00.000Z",
    );
    expect(firstBoundaryNotBefore(d("2026-12-20T00:00:00Z")).toISOString()).toBe(
      "2027-01-01T12:00:00.000Z",
    );
  });
});

describe("paid-through (r M5 + r4a)", () => {
  it("nothing paid: the go-live boundary (Oct 1 12:00Z)", () => {
    const r = paidThroughOf([OCT("OPEN")]);
    expect(r).toMatchObject({ ok: true, fromInvoices: false });
    expect(r.ok && r.paidThrough.getTime()).toBe(CATCHUP_GO_LIVE.getTime());
  });

  it("a legacy 00:00Z PAID October is paid-through Nov 1 12:00Z, not Nov 1 00:00Z (no 12 h re-billed)", () => {
    const r = paidThroughOf([inv("a", "PAID", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")]);
    expect(r.ok && r.paidThrough.toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });

  it("a contiguous run of PAID invoices is walked to its end (VOID/OPEN ignored)", () => {
    const r = paidThroughOf([
      inv("o", "PAID", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"),
      inv("n", "PAID", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z"),
      inv("x", "VOID", "2026-12-01T12:00:00Z", "2027-01-01T12:00:00Z"),
      inv("y", "OPEN", "2026-12-01T12:00:00Z", "2027-01-01T12:00:00Z"),
    ]);
    expect(r).toMatchObject({ ok: true, paidInvoiceIds: ["o", "n"] });
    expect(r.ok && r.paidThrough.toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });

  it("a PAID invoice AFTER a gap refuses (NEEDS RULING)", () => {
    expect(
      paidThroughOf([
        OCT("PAID"),
        inv("dec", "PAID", "2026-12-01T12:00:00Z", "2027-01-01T12:00:00Z"),
      ]),
    ).toEqual({ ok: false, reason: "paid_after_gap" });
  });

  it("a PAID invoice with no period cannot be placed: refuses", () => {
    expect(paidThroughOf([inv("p", "PAID", null, null)])).toEqual({
      ok: false,
      reason: "paid_invoice_without_period",
    });
  });

  it("history before go-live never lowers paid-through below Oct 1", () => {
    const r = paidThroughOf([inv("s", "PAID", "2026-08-01T12:00:00Z", "2026-09-01T12:00:00Z")]);
    expect(r.ok && r.paidThrough.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });
});

describe("the stub (r M5): price x unpaid days / days in month, add-ons included", () => {
  it("nothing paid, checkout Oct 9: ALL of October in full = the monthly price, labelled", () => {
    const p = plan({ monthly: 310 });
    expect(p.paidThrough.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(p.anchorAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.label).toBe("October 2026 subscription");
    expect(p.stub.lines).toEqual([{ kind: "PLAN", code: "PLAN", cents: 31000 }]);
    expect(p.stub.totalCents).toBe(31000);
  });

  it("an override price is whatever the caller resolved - amounts are whole cents via toCents (19.99 -> 1999)", () => {
    expect(plan({ monthly: 19.99 }).stub.totalCents).toBe(1999);
    expect(plan({ monthly: 0.1 + 0.2 }).stub.totalCents).toBe(30);
  });

  it("paid through Oct 15 with an add-on: base AND add-on for 17/31 days", () => {
    const p = plan({
      monthly: 310,
      addons: [{ sku: "FORECASTING", unitPrice: 31, quantity: 1 }],
      invoices: [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-10-15T12:00:00Z")],
    });
    expect(p.paidThrough.toISOString()).toBe("2026-10-15T12:00:00.000Z");
    expect(p.stub.lines).toEqual([
      { kind: "PLAN", code: "PLAN", cents: 17000 }, // 310 x 17/31
      { kind: "ADDON", code: "FORECASTING", cents: 1700 }, // 31 x 17/31
    ]);
    expect(p.stub.label).toBe("Oct 15 to Oct 31, 2026 subscription");
  });

  it("add-on quantity multiplies the unit price; a zero-priced or zero-quantity row adds no line", () => {
    const lines = stubLines(
      100,
      [
        { sku: "A", unitPrice: 10, quantity: 3 },
        { sku: "B", unitPrice: 0, quantity: 5 },
        { sku: "C", unitPrice: 10, quantity: 0 },
      ],
      d("2026-10-01T12:00:00Z"),
      d("2026-11-01T12:00:00Z"),
    );
    expect(lines).toEqual([
      { kind: "PLAN", code: "PLAN", cents: 10000 },
      { kind: "ADDON", code: "A", cents: 3000 },
    ]);
  });

  it("a session opened after Nov 1 covers the past days too: Oct 1 -> Dec 1 is TWO full months", () => {
    const p = plan({ now: d("2026-11-05T10:00:00Z"), monthly: 100 });
    expect(p.anchorAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(20000);
    expect(p.stub.label).toBe("October 2026 to November 2026 subscription");
  });

  it("different month lengths: Nov is 30 days (paid through Nov 14 12:00 -> 17/30 of December's hand-over)", () => {
    const p = plan({
      monthly: 300,
      invoices: [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")],
    });
    // paid through Nov 14: T = Dec 1 12:00Z (>= 72 h out): the stub is [Nov 14, Dec 1) = 17 days of 30
    expect(p.stub.from.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(p.stub.to.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(17000);
  });

  it("an under-$0.50 stub is flagged (and forgiven by the session builder)", () => {
    const p = plan({
      monthly: 5,
      now: d("2026-10-20T20:00:00Z"),
      invoices: [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-10-31T11:00:00Z")],
    });
    // paid-through Oct 31 11:00 (25 h before the boundary: no snap): stub = 25 h = 1.0417 d of 31 of $5 = $0.17
    expect(p.stub.totalCents).toBe(17);
    expect(p.stub.belowStripeMinimum).toBe(true);
    expect(p.shape).toBe("trial_one_time");
  });
});

describe("the Checkout shape (SA-733r9: every S < A is trial_one_time, S === A the stub-free trial)", () => {
  it("paid through Nov 14, checkout Oct 9: trial_one_time, A = Dec 1 12:00Z, the line [Nov 14, Dec 1) is charged at completion", () => {
    const p = plan({
      invoices: [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")],
    });
    expect(p.shape).toBe("trial_one_time");
    expect(p.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBeGreaterThan(0);
  });

  it("paid through Nov 1 (October paid), checkout Oct 9: the stub-free trial, trial_end = Nov 1, NO line", () => {
    const p = plan({ invoices: [OCT("PAID")] });
    expect(p.shape).toBe("trial");
    expect(p.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(0);
  });

  it("paid through Nov 1, checkout Oct 30: A moves to Dec 1 (>= now + 72 h) and November is a one-time line - anchor_no_line is gone", () => {
    const p = plan({ now: d("2026-10-30T09:00:00Z"), invoices: [OCT("PAID")] });
    expect(p.shape).toBe("trial_one_time");
    expect(p.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(p.stub.from.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(31000);
  });

  it("nothing paid (the usual October case): trial_one_time - A = Nov 1 12:00Z, October 31/31 as the one-time line", () => {
    const p = plan();
    expect(p.shape).toBe("trial_one_time");
    expect(p.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.from.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(p.stub.to.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(31000);
  });

  it("the 98 h trial-with-a-stub machinery is gone: over a spread of paid states and days no prepaid shape carries a stub", () => {
    for (const end of [
      "2026-10-30T12:00:00Z",
      "2026-11-01T12:00:00Z",
      "2026-11-14T12:00:00Z",
      "2026-11-29T12:00:00Z",
    ]) {
      for (const day of [
        "2026-10-09T10:00:00Z",
        "2026-10-28T04:00:00Z",
        "2026-10-29T04:00:00Z",
        "2026-11-27T10:00:00Z",
      ]) {
        const p = plan({ now: d(day), invoices: [inv("a", "PAID", "2026-10-01T12:00:00Z", end)] });
        if (p.shape === "trial") {
          expect(p.stub.totalCents).toBe(0);
          expect(p.stub.from.getTime()).toBe(p.stub.to.getTime());
        }
      }
    }
  });
});

describe("which RfInvoices fall under the lock-and-void rule", () => {
  it("nothing paid: the OPEN October invoice and an OPEN November issued ahead are both voided at settlement", () => {
    const p = plan({
      invoices: [
        OCT("OPEN", "oct"),
        inv("nov", "OPEN", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z"),
      ],
    });
    expect(p.voidInvoiceIds.sort()).toEqual(["nov", "oct"]);
  });

  it("October paid: only the invoices from paid-through on (November) - never the PAID one, never a VOID", () => {
    const p = plan({
      invoices: [
        OCT("PAID", "oct"),
        inv("nov", "OPEN", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z"),
        inv("v", "VOID", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z"),
      ],
    });
    expect(p.voidInvoiceIds).toEqual(["nov"]);
  });

  it("the 24 h snap tolerance applies to the start (a legacy 00:00Z November start is still November)", () => {
    const p = plan({
      invoices: [
        OCT("PAID", "oct"),
        inv("nov", "OPEN", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"),
      ],
    });
    expect(p.voidInvoiceIds).toEqual(["nov"]);
  });

  it("an OPEN invoice with no period is never voided blind: reported", () => {
    const p = plan({ invoices: [inv("x", "OPEN", null, null)] });
    expect(p.voidInvoiceIds).toEqual([]);
    expect(p.unplaceableOpenIds).toEqual(["x"]);
  });
});

describe("refusals", () => {
  it("no resolvable monthly price", () => {
    expect(planCatchup({ now: NOW, monthly: null, addons: [], invoices: [] })).toEqual({
      ok: false,
      reason: "no_monthly_price",
    });
  });

  it("a plan price of 0 (or less) is not billable", () => {
    for (const monthly of [0, -1]) {
      expect(planCatchup({ now: NOW, monthly, addons: [], invoices: [] })).toEqual({
        ok: false,
        reason: "no_billable_price",
      });
    }
  });

  it("a PAID invoice after a gap", () => {
    const r = planCatchup({
      now: NOW,
      monthly: 100,
      addons: [],
      invoices: [OCT("PAID"), inv("dec", "PAID", "2026-12-01T12:00:00Z", "2027-01-01T12:00:00Z")],
    });
    expect(r).toEqual({ ok: false, reason: "paid_after_gap" });
  });
});

describe("SA-733r5 selector rows", () => {
  it("catchupShape: S === A (>= now + 72 h) => trial; every S < A => trial_one_time", () => {
    const now = d("2026-10-09T10:00:00Z");
    expect(catchupShape({ paidThrough: d("2026-10-01T12:00:00Z"), now })).toBe("trial_one_time");
    expect(catchupShape({ paidThrough: d("2026-10-09T10:00:00Z"), now })).toBe("trial_one_time"); // = now
    expect(catchupShape({ paidThrough: d("2026-11-14T12:00:00Z"), now })).toBe("trial_one_time");
    expect(catchupShape({ paidThrough: d("2026-11-01T12:00:00Z"), now })).toBe("trial");
    expect(
      catchupShape({ paidThrough: d("2026-11-01T12:00:00Z"), now: d("2026-10-30T09:00:00Z") }),
    ).toBe("trial_one_time"); // A moves to Dec 1 (>= now + 72 h)
  });

  it("session Oct 30 unpaid since Oct 1: A = Dec 1 12:00Z, ONE line Oct 1 -> Nov 30 (two months)", () => {
    const p = plan({ now: d("2026-10-30T12:00:00Z"), monthly: 100 });
    expect(p.shape).toBe("trial_one_time");
    expect(p.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(20000);
    expect(p.stub.label).toBe("October 2026 to November 2026 subscription");
  });

  it("R5-2: the last 72 h before a 1st move A to the FOLLOWING 1st (that month is paid 1-3 days early), and say so", () => {
    const p = plan({ now: d("2026-10-29T12:01:00Z"), monthly: 100 });
    expect(p.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(p.notes.join(" ")).toMatch(/R5-2.*following month/);
    // exactly 72 h before the 1st is still the NEXT 1st
    const q = plan({ now: d("2026-10-29T12:00:00Z"), monthly: 100 });
    expect(q.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(q.notes.join(" ")).not.toMatch(/R5-2/);
  });

  it("A is always >= now + 72 h and a 1st at 12:00Z, whatever the instant (the Stripe 48 h trial floor with margin)", () => {
    for (let h = 0; h < 24 * 62; h += 7) {
      const now = new Date(Date.UTC(2026, 9, 2, 0, 0, 0) + h * 3600_000 + 17 * 60_000);
      const p = planCatchup({ now, monthly: 100, addons: [], invoices: [] });
      if (!p.ok || p.shape !== "trial_one_time") throw new Error("expected trial_one_time");
      expect(p.trialEndAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(72 * 3600_000);
      expect(p.trialEndAt.getUTCDate()).toBe(1);
      expect(p.trialEndAt.getUTCHours()).toBe(12);
    }
  });

  it("the one-time line includes add-ons (base + add-on for 31/31)", () => {
    const p = plan({ addons: [{ sku: "FORECASTING", unitPrice: 31, quantity: 2 }] });
    expect(p.stub.lines).toEqual([
      { kind: "PLAN", code: "PLAN", cents: 31000 },
      { kind: "ADDON", code: "FORECASTING", cents: 6200 },
    ]);
  });

  it("paid through mid-month, a 1st under 72 h away (stub >= $0.50): the one-time line bills it rather than leave it free", () => {
    const p = plan({
      now: d("2026-10-30T20:00:00Z"),
      monthly: 310,
      invoices: [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-10-30T23:00:00Z")],
    });
    expect(p.shape).toBe("trial_one_time");
    expect(p.stub.from.toISOString()).toBe("2026-10-30T23:00:00.000Z");
    expect(p.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });

  it("an OPEN invoice is superseded by its PERIOD END (after paid-through), not only by its start", () => {
    const p = plan({
      invoices: [
        inv("overlap", "OPEN", "2026-10-15T12:00:00Z", "2026-11-01T12:00:00Z"),
        inv("before", "OPEN", "2026-09-01T12:00:00Z", "2026-10-01T12:00:00Z"),
      ],
    });
    expect(p.voidInvoiceIds).toEqual(["overlap"]);
  });

  it("the catch-up pays CATCHUP_GO_LIVE-onwards only: history before go-live never lowers paid-through", () => {
    const r = paidThroughOf([inv("s", "PAID", "2026-08-01T12:00:00Z", "2026-09-01T12:00:00Z")]);
    expect(r.ok && r.paidThrough.getTime()).toBe(CATCHUP_GO_LIVE.getTime());
    expect(stubLines(100, [], CATCHUP_GO_LIVE, CATCHUP_GO_LIVE)).toEqual([]);
  });
});

describe("Opus item 9: the go-live floor is max(go-live, the tenant's billing start)", () => {
  it("a tenant activated Oct 20 is charged from Oct 20 08:30Z, not from Oct 1", () => {
    const p = planCatchup({
      now: d("2026-10-22T10:00:00Z"),
      monthly: 310,
      addons: [],
      invoices: [],
      billingStart: d("2026-10-20T08:30:00Z"),
    });
    if (!p.ok) throw new Error(p.reason);
    expect(p.paidThrough.toISOString()).toBe("2026-10-20T08:30:00.000Z");
    expect(p.stub.from.toISOString()).toBe("2026-10-20T08:30:00.000Z");
    expect(p.stub.totalCents).toBeLessThan(31000);
    expect(p.stub.totalCents).toBeGreaterThan(0);
  });

  it("a billing start BEFORE go-live (or none) leaves the floor at Oct 1 12:00Z", () => {
    for (const billingStart of [d("2026-08-01T00:00:00Z"), null, undefined]) {
      const p = planCatchup({ now: NOW, monthly: 310, addons: [], invoices: [], billingStart });
      if (!p.ok) throw new Error(p.reason);
      expect(p.paidThrough.getTime()).toBe(CATCHUP_GO_LIVE.getTime());
    }
  });

  it("paidThroughOf honours the floor for PAID history too (a PAID invoice before the floor never lowers it)", () => {
    const floor = d("2026-10-20T08:30:00Z");
    const r = paidThroughOf(
      [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-10-15T12:00:00Z")],
      floor,
    );
    expect(r.ok && r.paidThrough.getTime()).toBe(floor.getTime());
  });
});

describe("MF1: the manual invoice's add-ons vs the card checkout's lines", () => {
  const line = (sku: string, unitPrice: number, quantity = 1) => ({ sku, unitPrice, quantity });
  const row = (code: string, unitPrice: number | null, quantity = 1) => ({
    code,
    unitPrice,
    quantity,
  });

  it("a priced billable row with NO checkout line (a platform-admin-only SKU) is refused - it would be voided and never billed", () => {
    expect(addonCardRefusal([row("OCR_PACK_250", 25)], [])).toBe(
      "billable_addon_not_card_billable",
    );
    expect(addonCardRefusal([row("SEAT_EXTRA", 10, 3)], [line("FORECASTING", 31)])).toBe(
      "billable_addon_not_card_billable",
    );
  });

  it("a self-serve row whose snapshot differs from the catalog line (or whose duplicate rows change the quantity) is refused", () => {
    expect(addonCardRefusal([row("FORECASTING", 29)], [line("FORECASTING", 31)])).toBe(
      "addon_snapshot_not_catalog",
    );
    expect(
      addonCardRefusal([row("FORECASTING", 31), row("FORECASTING", 31)], [line("FORECASTING", 31)]),
    ).toBe("addon_snapshot_not_catalog");
    expect(
      addonCardRefusal(
        [row("FORECASTING", 31), row("FORECASTING", 30)],
        [line("FORECASTING", 31, 2)],
      ),
    ).toBe("addon_snapshot_not_catalog");
  });

  it("matching rows, unpriced rows and zero quantities never refuse", () => {
    expect(addonCardRefusal([row("FORECASTING", 31, 2)], [line("FORECASTING", 31, 2)])).toBeNull();
    expect(addonCardRefusal([row("OCR_PACK_250", null), row("SEAT_EXTRA", 0)], [])).toBeNull();
    expect(addonCardRefusal([row("SEAT_EXTRA", 10, 0)], [])).toBeNull();
    expect(addonCardRefusal([], [])).toBeNull();
  });

  it("the reverse direction: a checkout line with NO priced billable row would charge something the invoice never billed - refused", () => {
    expect(addonCardRefusal([], [line("FORECASTING", 31)])).toBe(
      "checkout_addon_without_priced_row",
    );
    // an unpriced row (snapshot null / 0) bills nothing on the invoice either: the card line is still new money
    expect(addonCardRefusal([row("FORECASTING", 0)], [line("FORECASTING", 31)])).toBe(
      "checkout_addon_without_priced_row",
    );
    expect(addonCardRefusal([row("FORECASTING", null)], [line("FORECASTING", 31)])).toBe(
      "checkout_addon_without_priced_row",
    );
    expect(addonCardRefusal([row("FORECASTING", 31)], [line("FORECASTING", 31)])).toBeNull();
  });

  it("planCatchup carries the refusal as a plan reason (and skips the check when no rows are passed)", () => {
    const base = { now: NOW, monthly: 310, addons: [], invoices: [] };
    expect(planCatchup({ ...base, billableRows: [row("OCR_PACK_250", 25)] })).toEqual({
      ok: false,
      reason: "billable_addon_not_card_billable",
    });
    expect(planCatchup(base).ok).toBe(true);
  });
});

describe("MF2 -> SA-733r9: paid coverage is ONE walk over every paid source, snapped", () => {
  const MARKER = "TENANT_MANUAL_ACTIVATION_MARKER";
  const TRAIL = "TENANT_SUBSCRIPTION_ACTIVATED";
  /** One manual activation = its in-tx marker (with the recorded period) + the post-commit trail row seconds later. */
  const activation = (start: string, end: string): ActivationRecord[] => [
    { action: MARKER, at: d(start), periodStart: d(start), periodEnd: d(end) },
    { action: TRAIL, at: new Date(d(start).getTime() + 3000), periodEnd: d(end) },
  ];
  const OPEN_OCT = inv("oct", "OPEN", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
  const run = (activations: ActivationRecord[], invoices: CatchupInvoice[] = [OPEN_OCT]) =>
    planCatchup({
      now: NOW,
      monthly: 310,
      addons: [],
      invoices,
      manual: { activations },
    });
  const okPlan = (r: ReturnType<typeof run>) => {
    if (!r.ok) throw new Error(`plan refused: ${r.reason}`);
    return r;
  };

  it("the normal unpaid-October tenant (Sept paid by invoice through Oct 1, October only an OPEN requirement) stays eligible", () => {
    const sepPaid = inv("sep", "PAID", "2026-09-01T12:00:00Z", "2026-10-01T12:00:00Z");
    const r = run(activation("2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z"), [sepPaid, OPEN_OCT]);
    expect(r.ok).toBe(true);
  });

  it("activated Sep 10 for 30 days ([Sep 10, Oct 10)): ELIGIBLE - S = Oct 10, the line is Oct 10 -> Nov 1 (22 of 31 days)", () => {
    const r = okPlan(run(activation("2026-09-10T09:00:00Z", "2026-10-10T09:00:00Z")));
    expect(r.stub.from.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    expect(r.shape).toBe("trial_one_time");
    expect(r.stub.totalCents).toBeGreaterThan(20000);
  });

  it("activated Sep 26 ([Sep 26, Oct 26)): S = Oct 26 while the next window is OPEN; once it is PAID the run is contiguous to Nov 1", () => {
    const sep26 = activation("2026-09-26T09:00:00Z", "2026-10-26T09:00:00Z");
    const next = (status: string) =>
      inv("next", status, "2026-10-26T09:00:00Z", "2026-11-01T12:00:00Z");
    expect(okPlan(run(sep26, [])).stub.from.toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect(okPlan(run(sep26, [next("OPEN")])).stub.from.toISOString()).toBe(
      "2026-10-26T09:00:00.000Z",
    );
    const paidNext = okPlan(run(sep26, [next("PAID")]));
    expect(paidNext.stub.from.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(paidNext.shape).toBe("trial");
  });

  it("coverage ending one minute past the first charged service start snaps to it (no half-days)", () => {
    expect(
      okPlan(
        run(activation("2026-09-01T12:01:00Z", "2026-10-01T12:01:00Z")),
      ).stub.from.toISOString(),
    ).toBe("2026-10-01T12:00:00.000Z");
  });

  it("EVERY activation counts: Aug->Sep 1 then Oct 5 leaves Sep 1..Oct 5 unpaid (a gap): paid_after_gap", () => {
    const aug = activation("2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z");
    expect(run([...aug, ...activation("2026-10-05T09:00:00Z", "2026-11-04T09:00:00Z")])).toEqual({
      ok: false,
      reason: "paid_after_gap",
    });
    // overlapping activations: the long one is NOT the latest and still decides the end
    const r = okPlan(
      run([
        ...activation("2026-09-05T09:00:00Z", "2026-12-04T09:00:00Z"),
        ...activation("2026-09-20T09:00:00Z", "2026-09-25T09:00:00Z"),
      ]),
    );
    expect(r.stub.from.toISOString()).toBe("2026-12-04T09:00:00.000Z");
  });

  it("a PAID RfInvoice window reaching into the anchor month (to Oct 5) is paid coverage: S = Oct 5", () => {
    const paid = inv("p", "PAID", "2026-09-05T12:00:00Z", "2026-10-05T12:00:00Z");
    expect(okPlan(run([], [paid, OPEN_OCT])).stub.from.toISOString()).toBe(
      "2026-10-05T12:00:00.000Z",
    );
  });

  describe("ruling 8(e): paid coverage that lands on an anchor 1st is the stub-free trial", () => {
    const trialTo = (r: ReturnType<typeof run>, iso: string) => {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.shape).toBe("trial");
      expect(r.trialEndAt.toISOString()).toBe(iso);
      expect(r.stub.totalCents).toBe(0); // nothing is charged for days that are already paid
      expect(r.stub.lines).toEqual([]);
    };

    it("a PAID October window ending Nov 1 12:00Z: trial to Nov 1, no line", () => {
      const paidOct = inv("po", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
      trialTo(run([], [paidOct]), "2026-11-01T12:00:00.000Z");
    });

    it("... and the same window in the legacy 00:00Z spelling", () => {
      const legacy = inv("pl", "PAID", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
      trialTo(run([], [legacy]), "2026-11-01T12:00:00.000Z");
    });

    it("two months paid (to Dec 1): trial to Dec 1", () => {
      const paid2 = inv("p2", "PAID", "2026-10-01T12:00:00Z", "2026-12-01T12:00:00Z");
      trialTo(run([], [paid2]), "2026-12-01T12:00:00.000Z");
    });

    it("paid by an ACTIVATION alone to an anchor 1st (365 days from Sep 1 12:00Z): trial to that 1st - October is NOT charged again", () => {
      trialTo(
        run(activation("2026-09-01T12:00:00Z", "2027-09-01T12:00:00Z"), [OPEN_OCT]),
        "2027-09-01T12:00:00.000Z",
      );
    });

    it("a window ending within 24 h of a 1st (06:00Z, a second either side, the 2nd, a local-time spelling) snaps to that 1st", () => {
      const ends = [
        "2026-11-01T06:00:00Z",
        "2026-11-01T12:00:01Z",
        "2026-11-01T11:59:59Z",
        "2026-11-02T12:00:00Z",
        "2026-11-01T00:00:01Z",
        "2026-10-31T23:59:59Z",
        "2026-11-01T05:00:00Z",
      ];
      for (const end of ends) {
        trialTo(
          run([], [inv("x", "PAID", "2026-10-01T12:00:00Z", end)]),
          "2026-11-01T12:00:00.000Z",
        );
      }
    });

    it("a window ending mid-month (Nov 3) is NOT snapped: S = Nov 3 12:00Z exactly and the line prorates", () => {
      const r = okPlan(run([], [inv("x", "PAID", "2026-10-01T12:00:00Z", "2026-11-03T12:00:00Z")]));
      expect(r.stub.from.toISOString()).toBe("2026-11-03T12:00:00.000Z");
      expect(r.shape).toBe("trial_one_time");
    });

    it("an anchor 1st plus a later activation end: the LATEST end decides (S = Nov 4)", () => {
      const paidOct = inv("po", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
      const r = okPlan(run(activation("2026-10-05T09:00:00Z", "2026-11-04T09:00:00Z"), [paidOct]));
      expect(r.stub.from.toISOString()).toBe("2026-11-04T09:00:00.000Z");
    });

    it("through the planner a prepaid shape never carries a line, whatever the paid end", () => {
      const days = [
        "2026-10-09T10:00:00Z",
        "2026-10-28T04:00:00Z",
        "2026-10-29T04:00:00Z",
        "2026-10-30T09:00:00Z",
      ];
      const paidEnds = [
        "2026-10-05T12:00:00Z",
        "2026-10-30T12:00:00Z",
        "2026-11-01T12:00:00Z",
        "2026-11-14T12:00:00Z",
        "2026-12-01T12:00:00Z",
      ];
      for (const end of paidEnds) {
        for (const day of days) {
          const r = planCatchup({
            now: d(day),
            monthly: 310,
            addons: [],
            invoices: [inv("p", "PAID", "2026-10-01T12:00:00Z", end)],
            manual: { activations: [] },
          });
          if (!r.ok) continue;
          if (r.shape === "trial") {
            expect(r.stub.totalCents).toBe(0);
            expect(r.stub.lines).toEqual([]);
          }
        }
      }
    });
  });

  it("a PAID window ending exactly at the start (Sept) is the normal paid-up state and stays eligible", () => {
    const sep = inv("sep", "PAID", "2026-09-01T12:00:00Z", "2026-10-01T12:00:00Z");
    expect(run([], [sep, OPEN_OCT]).ok).toBe(true);
  });

  it("a rollCycles period is a REQUIREMENT, not coverage: a tenant with no marker and only OPEN windows is eligible", () => {
    expect(run([], [OPEN_OCT]).ok).toBe(true);
  });

  it("without the manual input (the pure planner) activations are not read: a prepaid plan still plans", () => {
    const paid = inv("p", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z");
    const p = planCatchup({ now: NOW, monthly: 310, addons: [], invoices: [paid] });
    expect(p.ok && p.shape).toBe("trial_one_time");
  });

  describe("legacy markers (no recorded period) fail closed, PER activation cluster", () => {
    const LEGACY = { ok: false, reason: "manual_marker_without_period" };

    it("a trail row alone (a pre-marker activation) or a marker without a period: refused", () => {
      expect(run([{ action: TRAIL, at: d("2026-08-02T10:00:00Z") }])).toEqual(LEGACY);
      expect(run([{ action: MARKER, at: d("2026-08-02T10:00:00Z") }])).toEqual(LEGACY);
    });

    it("one activation = marker + trail: EITHER row carrying the period is enough", () => {
      const at = d("2026-08-02T10:00:00Z");
      const later = new Date(at.getTime() + 3000);
      const end = d("2026-09-01T10:00:00Z");
      expect(
        run([
          { action: MARKER, at },
          { action: TRAIL, at: later, periodEnd: end },
        ]).ok,
      ).toBe(true);
      expect(
        run([
          { action: MARKER, at, periodEnd: end },
          { action: TRAIL, at: later },
        ]).ok,
      ).toBe(true);
    });

    it("the rule is per cluster: a good activation does not excuse a later legacy one", () => {
      expect(
        run([
          ...activation("2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z"),
          { action: TRAIL, at: d("2026-09-15T10:00:00Z") },
        ]),
      ).toEqual(LEGACY);
    });
  });

  describe("activationClusters", () => {
    it("no activations: no clusters, no first start", () => {
      expect(activationClusters([])).toEqual({ ok: true, clusters: [], firstStart: null });
    });

    it("one window per activation, the first start across ALL of them", () => {
      const r = activationClusters([
        ...activation("2026-08-02T10:00:00Z", "2026-09-01T10:00:00Z"),
        ...activation("2026-09-05T09:00:00Z", "2026-10-05T09:00:00Z"),
      ]);
      expect(r.ok && r.clusters.map((c) => c.end.toISOString())).toEqual([
        "2026-09-01T10:00:00.000Z",
        "2026-10-05T09:00:00.000Z",
      ]);
      expect(r.ok && r.firstStart!.toISOString()).toBe("2026-08-02T10:00:00.000Z");
    });

    it("a cluster with an end but no start uses its earliest `at` as the start", () => {
      const at = d("2026-10-15T12:00:00Z");
      const r = activationClusters([
        { action: MARKER, at },
        { action: TRAIL, at: new Date(at.getTime() + 3000), periodEnd: d("2026-11-14T12:00:00Z") },
      ]);
      expect(r.ok && r.clusters[0].start.toISOString()).toBe("2026-10-15T12:00:00.000Z");
    });

    it("a voided cluster keeps its start (the activation happened) but the planner ignores its window", () => {
      const rows = activation("2026-10-12T04:08:24Z", "2026-11-11T04:08:24Z").map((r) => ({
        ...r,
        voided: true,
      }));
      const r = activationClusters(rows);
      expect(r.ok && r.clusters[0].voided).toBe(true);
      const p = okPlan(run(rows, [OPEN_OCT]));
      expect(p.stub.from.toISOString()).toBe("2026-10-12T04:08:24.000Z");
    });
  });
});
