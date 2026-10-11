import * as fs from "fs";
import * as path from "path";
import {
  CATCHUP_GO_LIVE,
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
    expect(p.stub.label).toBe("Subscription — October 2026");
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
    expect(p.stub.label).toBe("Subscription — October 2026 (from Oct 15)");
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
    expect(p.stub.label).toBe("Subscription — October 2026 to November 2026");
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

  it("an under-$0.50 stub is flagged and skipped", () => {
    const p = plan({
      monthly: 5,
      now: d("2026-10-30T20:00:00Z"),
      invoices: [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-10-31T11:00:00Z")],
    });
    // paid-through Oct 31 11:00 (25 h before the boundary: no snap): stub = 25 h = 1.0417 d of 31 of $5 = $0.17
    expect(p.stub.totalCents).toBe(17);
    expect(p.stub.belowStripeMinimum).toBe(true);
    expect(p.shape).toBe("anchor_no_line");
  });
});

describe("the Checkout shape (r3 N3 + Stripe's documented Checkout limits)", () => {
  it("paid through Nov 14, checkout Oct 9: trial_end = Dec 1 12:00Z, stub [Nov 14, Dec 1) - the trial branch", () => {
    const p = plan({
      invoices: [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")],
    });
    expect(p.shape).toBe("trial");
    expect(p.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });

  it("paid through Nov 1 (October paid), checkout Oct 9: trial_end = Nov 1, NO stub", () => {
    const p = plan({ invoices: [OCT("PAID")] });
    expect(p.shape).toBe("trial");
    expect(p.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(0);
  });

  it("paid through Nov 1, checkout Oct 30: T is under 72 h away -> no trial, anchor Nov 1, stub $0, NO one-time line", () => {
    const p = plan({ now: d("2026-10-30T09:00:00Z"), invoices: [OCT("PAID")] });
    expect(p.shape).toBe("anchor_no_line");
    expect(p.anchorAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(0);
  });

  it("nothing paid (the usual October case): trial_one_time (SA-733r5) - A = Nov 1 12:00Z, October 31/31 as the one-time line", () => {
    const p = plan();
    expect(p.shape).toBe("trial_one_time");
    expect(p.trialEndAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.from.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(p.stub.to.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(31000);
  });

  it("the prepaid trial needs 72 h: exactly 72 h out is a trial, 1 minute less is not", () => {
    // paid through Nov 29 12:00 => T = Dec 1 12:00Z
    const inv72 = [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-11-29T12:00:00Z")];
    expect(plan({ now: d("2026-11-28T12:00:00Z"), invoices: inv72 }).shape).toBe("trial");
    expect(plan({ now: d("2026-11-28T12:01:00Z"), invoices: inv72 }).shape).not.toBe("trial");
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
  it("catchupShape: paid-through <= now => trial_one_time; T >= now + 72 h => trial; else anchor_no_line", () => {
    const now = d("2026-10-09T10:00:00Z");
    expect(catchupShape({ paidThrough: d("2026-10-01T12:00:00Z"), now })).toBe("trial_one_time");
    expect(catchupShape({ paidThrough: d("2026-10-09T10:00:00Z"), now })).toBe("trial_one_time"); // = now
    expect(catchupShape({ paidThrough: d("2026-11-14T12:00:00Z"), now })).toBe("trial");
    expect(
      catchupShape({ paidThrough: d("2026-11-01T12:00:00Z"), now: d("2026-10-30T09:00:00Z") }),
    ).toBe("anchor_no_line");
  });

  it("session Oct 30 unpaid since Oct 1: A = Dec 1 12:00Z, ONE line Oct 1 -> Nov 30 (two months)", () => {
    const p = plan({ now: d("2026-10-30T12:00:00Z"), monthly: 100 });
    expect(p.shape).toBe("trial_one_time");
    expect(p.trialEndAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(p.stub.totalCents).toBe(20000);
    expect(p.stub.label).toBe("Subscription — October 2026 to November 2026");
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
    expect(addonCardRefusal([], [line("FORECASTING", 31)])).toBeNull();
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
