import * as fs from "fs";
import * as path from "path";
import * as planMod from "./catchup-plan";
import { catchupShape, describeStub, planCatchup, type CatchupInvoice } from "./catchup-plan";
import { snapToBoundary } from "./rf-invoice/calendar-windows";
import { refusalCodeOf } from "./catchup-refusal";

/**
 * SA-733r9 + r10 (row 339, the prorated catch-up) - PHASE 1: the red rows for the PURE planner symbols
 * (error codes, price refusals, describeStub labels, the selector, the paid-coverage walk) and the void-rule pins.
 * Behaviour through the service lives in catchup-prorated.service.spec.ts.
 *
 * RED = fails on master 5a938f0a2 today; PIN = already green, kept as a guard.
 *
 * NEW SYMBOLS ASSUMED by these rows (phase 2 must use the same names or change the row):
 *   - `paidCoverage(floor, { paidRfWindows, activationWindows })` exported from catchup-plan.ts, returning
 *     `{ ok: true, paidThrough: Date } | { ok: false, reason }`; a window is `{ periodStart: Date, periodEnd: Date }`.
 *   - the plan refusal reason `no_billable_price` (plan price <= 0) mapped to the coded refusal
 *     `CATCHUP_NO_BILLABLE_PRICE` in catchup-refusal.ts, declared in BOTH error-code files.
 * They are reached through a namespace import so a missing export fails the ROW, never the file.
 */

const d = (iso: string) => new Date(iso);
const inv = (id: string, status: string, start: string, end: string): CatchupInvoice => ({
  id,
  status,
  periodStart: d(start),
  periodEnd: d(end),
});
const NOW = d("2026-10-09T10:00:00Z");

describe("RED: CATCHUP_NO_BILLABLE_PRICE is a declared error code in BOTH shared files", () => {
  const apiFile = path.join(__dirname, "../common/api-error-codes.ts");
  const typesFile = path.join(__dirname, "../../../../packages/types/api/error-codes.ts");

  it("apps/api/src/common/api-error-codes.ts declares CATCHUP_NO_BILLABLE_PRICE", () => {
    expect(fs.readFileSync(apiFile, "utf8")).toMatch(
      /CATCHUP_NO_BILLABLE_PRICE:\s*"CATCHUP_NO_BILLABLE_PRICE"/,
    );
  });

  it("packages/types/api/error-codes.ts declares CATCHUP_NO_BILLABLE_PRICE", () => {
    expect(fs.readFileSync(typesFile, "utf8")).toMatch(
      /CATCHUP_NO_BILLABLE_PRICE:\s*"CATCHUP_NO_BILLABLE_PRICE"/,
    );
  });

  it("the internal reason no_billable_price maps to that code (and not to the generic not-eligible)", () => {
    expect(refusalCodeOf("no_billable_price")).toBe("CATCHUP_NO_BILLABLE_PRICE");
  });
});

describe("the plan price refusal (r9 rule 7): null -> no_monthly_price, <= 0 -> no_billable_price", () => {
  const base = { now: NOW, addons: [], invoices: [] };

  it("PIN: a null resolved plan price refuses no_monthly_price (NO_MONTHLY_PRICE)", () => {
    expect(planCatchup({ ...base, monthly: null })).toEqual({
      ok: false,
      reason: "no_monthly_price",
    });
  });

  it("RED: a plan price of 0 refuses no_billable_price (CATCHUP_NO_BILLABLE_PRICE), it does not plan a $0 catch-up", () => {
    expect(planCatchup({ ...base, monthly: 0 })).toEqual({
      ok: false,
      reason: "no_billable_price",
    });
  });

  it("RED: a negative plan price is also not billable", () => {
    expect(planCatchup({ ...base, monthly: -5 })).toEqual({
      ok: false,
      reason: "no_billable_price",
    });
  });

  it("RED: add-ons alone never make a card plan - a priced add-on beside a $0 plan is still refused", () => {
    const r = planCatchup({
      ...base,
      monthly: 0,
      addons: [{ sku: "FORECASTING", unitPrice: 31, quantity: 1 }],
    });
    expect(r.ok).toBe(false);
  });

  it("PIN: a tiny positive price is billable (the sub-50-cent LINE is forgiven, the price is not refused)", () => {
    expect(planCatchup({ ...base, monthly: 0.3 }).ok).toBe(true);
  });
});

describe("describeStub labels a mid-month start with the start (r10 nit 2)", () => {
  it("RED: [Nov 11, Dec 1) -> 'Subscription — Nov 11 to Nov 30, 2026', never a bare month name", () => {
    expect(describeStub(d("2026-11-11T12:00:00Z"), d("2026-12-01T12:00:00Z"))).toBe(
      "Subscription — Nov 11 to Nov 30, 2026",
    );
  });

  it("RED: [Oct 10, Nov 1) -> 'Subscription — Oct 10 to Oct 31, 2026'", () => {
    expect(describeStub(d("2026-10-10T12:00:00Z"), d("2026-11-01T12:00:00Z"))).toBe(
      "Subscription — Oct 10 to Oct 31, 2026",
    );
  });

  it("RED: a mid-month start across two months -> 'Subscription — Oct 10 to Nov 30, 2026'", () => {
    expect(describeStub(d("2026-10-10T12:00:00Z"), d("2026-12-01T12:00:00Z"))).toBe(
      "Subscription — Oct 10 to Nov 30, 2026",
    );
  });

  it("PIN: whole months keep their month-name label", () => {
    expect(describeStub(d("2026-10-01T12:00:00Z"), d("2026-11-01T12:00:00Z"))).toBe(
      "Subscription — October 2026",
    );
    expect(describeStub(d("2026-10-01T12:00:00Z"), d("2026-12-01T12:00:00Z"))).toBe(
      "Subscription — October 2026 to November 2026",
    );
  });
});

describe("the selector: every S < A is trial_one_time, charged at completion (r10 nit 4)", () => {
  it("RED: a FUTURE mid-month paid-through (Nov 14, session Oct 9) is trial_one_time, no longer 'trial'", () => {
    expect(catchupShape({ paidThrough: d("2026-11-14T12:00:00Z"), now: NOW })).toBe(
      "trial_one_time",
    );
  });

  it("RED: a mid-month paid-through 1-3 days before a 1st is no longer anchor_no_line", () => {
    expect(
      catchupShape({
        paidThrough: d("2026-10-30T12:00:00Z"),
        now: d("2026-10-28T04:00:00Z"),
      }),
    ).toBe("trial_one_time");
  });

  it("PIN: a paid-through already <= now stays trial_one_time", () => {
    expect(catchupShape({ paidThrough: d("2026-10-01T12:00:00Z"), now: NOW })).toBe(
      "trial_one_time",
    );
  });

  it("PIN: paid exactly through a 1st at least 72 h out (S === A) is the stub-free 8(e) trial", () => {
    expect(catchupShape({ paidThrough: d("2026-11-01T12:00:00Z"), now: NOW })).toBe("trial");
  });
});

describe("the paid-coverage walk (r9 rule 1): one walk over PAID RfInvoice windows AND activation windows", () => {
  const walk = (floor: Date, paidRfWindows: unknown[], activationWindows: unknown[]) => {
    const fn = (planMod as unknown as Record<string, unknown>).paidCoverage;
    if (typeof fn !== "function") {
      throw new Error("paidCoverage is not exported from catchup-plan.ts yet (phase 2)");
    }
    return (fn as (f: Date, w: object) => any)(floor, { paidRfWindows, activationWindows });
  };
  const win = (start: string, end: string) => ({ periodStart: d(start), periodEnd: d(end) });

  it("RED: activations Sep 10 -> Oct 10 and Oct 20 -> Nov 20 leave a gap at Oct 10: paid_after_gap", () => {
    const r = walk(
      d("2026-10-01T12:00:00Z"),
      [],
      [
        win("2026-09-10T12:00:00Z", "2026-10-10T12:00:00Z"),
        win("2026-10-20T12:00:00Z", "2026-11-20T12:00:00Z"),
      ],
    );
    expect(r).toMatchObject({ ok: false, reason: "paid_after_gap" });
  });

  it("RED: an activation window and a PAID RfInvoice window that meet are ONE run (paidThrough Dec 1)", () => {
    const r = walk(
      d("2026-10-12T04:08:24Z"),
      [win("2026-11-11T04:08:24Z", "2026-12-01T12:00:00Z")],
      [win("2026-10-12T04:08:24Z", "2026-11-11T04:08:24Z")],
    );
    expect(r.ok).toBe(true);
    expect(r.paidThrough.toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });

  it("RED: boundaries compare SNAPPED - an Oct 31 20:00 end meets a legacy Nov 1 00:00 start", () => {
    const r = walk(
      d("2026-10-01T12:00:00Z"),
      [win("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")],
      [win("2026-09-01T12:00:00Z", "2026-10-31T20:00:00Z")],
    );
    expect(r.ok).toBe(true);
    expect(snapToBoundary(r.paidThrough).toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });

  it("RED: nothing paid: paidThrough is the floor itself", () => {
    const floor = d("2026-10-15T12:00:00Z");
    const r = walk(floor, [], []);
    expect(r.ok).toBe(true);
    expect(r.paidThrough.getTime()).toBe(floor.getTime());
  });

  it("RED: history that ends before the floor never lowers it", () => {
    const floor = d("2026-10-01T12:00:00Z");
    const r = walk(floor, [win("2026-08-01T12:00:00Z", "2026-09-01T12:00:00Z")], []);
    expect(r.ok).toBe(true);
    expect(r.paidThrough.getTime()).toBe(floor.getTime());
  });
});

describe("the void rule (r9 rule 4): master's rule, no upper bound - these rows guard it against r8's 'ends <= A'", () => {
  const paidOct = inv("oct", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");

  it("PIN (labelled RED in r9, but master's rule already holds): OPEN [Nov 1, Dec 1) issued early + OPEN [Nov 29, Jan 1) merged are BOTH voided", () => {
    const p = planCatchup({
      now: NOW,
      monthly: 310,
      addons: [],
      invoices: [
        paidOct,
        inv("early", "OPEN", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z"),
        inv("merged", "OPEN", "2026-11-29T12:00:00Z", "2027-01-01T12:00:00Z"),
      ],
    });
    if (!p.ok) throw new Error(p.reason);
    expect(p.voidInvoiceIds.sort()).toEqual(["early", "merged"]);
  });

  it("PIN: the straddle - an OPEN invoice that starts before paid-through and ends after it is voided", () => {
    const p = planCatchup({
      now: NOW,
      monthly: 310,
      addons: [],
      invoices: [
        inv("pre", "PAID", "2026-10-01T12:00:00Z", "2026-10-10T12:00:00Z"),
        inv("straddle", "OPEN", "2026-10-05T12:00:00Z", "2026-11-01T12:00:00Z"),
      ],
    });
    if (!p.ok) throw new Error(p.reason);
    expect(p.voidInvoiceIds).toEqual(["straddle"]);
  });

  it("PIN: a PAID invoice and a VOID one are never targets", () => {
    const p = planCatchup({
      now: NOW,
      monthly: 310,
      addons: [],
      invoices: [
        paidOct,
        inv("dec", "PAID", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z"),
        inv("gone", "VOID", "2026-12-01T12:00:00Z", "2027-01-01T12:00:00Z"),
      ],
    });
    if (!p.ok) throw new Error(p.reason);
    expect(p.voidInvoiceIds).toEqual([]);
  });
});
