import {
  CATCHUP_GO_LIVE,
  firstBoundaryOnOrAfter,
  isContiguous,
  paidThroughOf,
  planCatchup,
  snapToBoundary,
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

describe("snap / contiguity (SA-744r2 item 4, via SA-733r4 r4a)", () => {
  it("an end within 24 h (inclusive) of a 1st 12:00Z snaps to it; otherwise it is left alone", () => {
    expect(snapToBoundary(d("2026-11-01T00:00:00Z")).toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    expect(snapToBoundary(d("2026-10-31T12:00:00Z")).toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    ); // exactly 24 h
    expect(snapToBoundary(d("2026-10-31T11:59:59Z")).toISOString()).toBe(
      "2026-10-31T11:59:59.000Z",
    ); // 24 h + 1 s
    expect(snapToBoundary(d("2026-11-02T12:00:00Z")).toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    ); // exactly +24 h
    expect(snapToBoundary(d("2026-10-15T12:00:00Z")).toISOString()).toBe(
      "2026-10-15T12:00:00.000Z",
    );
  });

  it("contiguous = the next start is within the inclusive 24 h snap of the previous end", () => {
    const end = d("2026-11-01T00:00:00Z"); // legacy 00:00Z end, snaps to Nov 1 12:00Z
    expect(isContiguous(end, d("2026-11-01T12:00:00Z"))).toBe(true);
    expect(isContiguous(end, d("2026-11-02T12:00:00Z"))).toBe(true); // exactly 24 h after the snap
    expect(isContiguous(end, d("2026-11-02T12:00:01Z"))).toBe(false);
    expect(isContiguous(end, d("2026-10-31T12:00:00Z"))).toBe(true); // 24 h overlap
    expect(isContiguous(end, d("2026-10-30T12:00:00Z"))).toBe(false);
  });

  it("firstBoundaryOnOrAfter", () => {
    expect(firstBoundaryOnOrAfter(d("2026-11-01T12:00:00Z")).toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    expect(firstBoundaryOnOrAfter(d("2026-11-14T12:00:00Z")).toISOString()).toBe(
      "2026-12-01T12:00:00.000Z",
    );
    expect(firstBoundaryOnOrAfter(d("2026-12-20T00:00:00Z")).toISOString()).toBe(
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

  it("nothing paid (the usual October case): the D7 shape Checkout rejects -> needs_ruling, never silently built", () => {
    const p = plan();
    expect(p.shape).toBe("needs_ruling");
    expect(p.notes.join(" ")).toMatch(/NEEDS RULING.*one-time line.*proration_behavior=none/);
  });

  it("the trial needs 72 h: exactly 72 h out is a trial, 1 minute less is not", () => {
    const inv72 = [inv("a", "PAID", "2026-10-01T12:00:00Z", "2026-11-14T12:00:00Z")];
    // T = Dec 1 12:00Z
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
