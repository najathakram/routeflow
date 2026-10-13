jest.mock("./coupon-state", () => ({
  applyCouponStateTx: jest.fn(async () => ({ applied: true, stale: false, amountDelta: 0 })),
}));
import * as fs from "fs";
import * as path from "path";
import { CatchupClaimService } from "./catchup-claim.service";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup, type FakeInvoice } from "../testing/fake-stripe-catchup";

/**
 * SA-733r10 MF-A (MONEY) + r9 rule 4/5 - PHASE 1 red rows for the SETTLE path: settle voids from the S the session
 * was built and paid for (`session.metadata.catchup_from`), never from a recompute of paid coverage, and a no-line
 * session settles at completion. In-memory store + the stateful Stripe fake (no network). The real-Postgres twin of
 * the MF-A row is in catchup-claim.db.spec.ts. RED = fails on master 5a938f0a2; PIN = green today, kept as a guard.
 */
const d = (iso: string) => new Date(iso);
const SESSION = "cs_1";
const SUB = "sub_1";
const T = "t1";
const SESSION_EXPIRES_AT = Math.floor(d("2026-10-10T10:00:00Z").getTime() / 1000);

const row = (id: string, status: string, start: string, end: string) => ({
  id,
  tenantId: T,
  status,
  number: `RF-${id}`,
  periodStart: d(start),
  periodEnd: d(end),
  periodKey: `k-${id}`,
});

/** The MF-A fixture: activation [Oct 12, Nov 11) paid, PAID RfInvoice [Nov 11, Dec 1) (Zelle), OPEN [Dec 1, Jan 1). */
const PAID_OCT = row("inv_a", "PAID", "2026-10-12T04:08:24Z", "2026-11-11T04:08:24Z");
const PAID_NOV = row("inv_b", "PAID", "2026-11-11T04:08:24Z", "2026-12-01T12:00:00Z");
const OPEN_DEC = row("inv_dec", "OPEN", "2026-12-01T12:00:00Z", "2027-01-01T12:00:00Z");

/** Session metadata as the builders must write it: BOTH keys on every shape (MF-B). */
const meta = (over: Record<string, string> = {}) => ({
  tenantId: T,
  catchup: "prepaid",
  catchup_shape: "trial",
  catchup_stub_cents: "0",
  catchup_from: "2026-12-01T12:00:00.000Z",
  catchup_to: "2026-12-01T12:00:00.000Z",
  ...over,
});

function make(
  sub: Record<string, unknown>,
  invoices: Record<string, unknown>[],
  sessionMeta: Record<string, string>,
  stripeInvoices: FakeInvoice[] = [],
) {
  const db = fakeCatchupDb({ subs: [{ tenantId: T, ...sub }], invoices });
  const stripe = fakeStripeCatchup({
    invoices: stripeInvoices,
    subs: {
      [SUB]: {
        id: SUB,
        customer: "cus_1",
        status: "trialing",
        latest_invoice: null,
        default_payment_method: "pm_1",
      },
    },
    sessions: {
      [SESSION]: { id: SESSION, subscription: SUB, status: "complete", metadata: sessionMeta },
    },
  });
  const svc = new CatchupClaimService(db.prisma, stripe as any, { emit: jest.fn() } as any);
  return {
    db,
    stripe,
    svc,
    sub: () => db.subs[0],
    inv: (id: string) => db.invoices.find((i) => i.id === id)!,
    voided: () => db.audits.filter((a) => a.action === "RF_INVOICE_VOIDED").length,
    needsRuling: () => db.audits.some((a) => a.meta?.kind === "billing_catchup_needs_ruling"),
  };
}

const awaiting = (over: Record<string, unknown> = {}) => ({
  stripeSubId: SUB,
  externalPayment: false,
  catchupState: "AWAITING_FIRST_PAYMENT",
  catchupSessionId: SESSION,
  catchupInvoiceId: null,
  ...over,
});
const sessionOf = (m: Record<string, string>) => ({
  id: SESSION,
  customer: "cus_1",
  subscription: SUB,
  payment_status: "no_payment_required",
  expires_at: SESSION_EXPIRES_AT,
  metadata: m,
});

describe("RED MF-A: settle voids from the session's S, not from a recompute of paid coverage", () => {
  it("activation [Oct 12, Nov 11) + PAID [Nov 11, Dec 1): S = A = Dec 1 - settle voids the OPEN [Dec 1, Jan 1) ONCE and leaves both PAID rows alone (master: paid_after_gap, nothing voided)", async () => {
    const h = make(awaiting(), [PAID_OCT, PAID_NOV, OPEN_DEC], meta());
    expect(await h.svc.settle(T, SUB)).toBe(true);
    expect(h.inv("inv_dec").status).toBe("VOID");
    expect(h.inv("inv_a").status).toBe("PAID");
    expect(h.inv("inv_b").status).toBe("PAID");
    expect(h.voided()).toBe(1);
    expect(h.needsRuling()).toBe(false); // the walk from Oct 1 is never run, so there is nothing to rule on
    expect(h.sub()).toMatchObject({ catchupState: null, externalPayment: false });
  });

  it("... and the same session settles AT COMPLETION: the trialing sub exists with its card, so the claim clears and the OPEN invoice is voided without waiting for a money invoice (r9 rule 5)", async () => {
    const h = make(
      { ...awaiting(), catchupState: "SESSION_OPEN", externalPayment: true },
      [PAID_OCT, PAID_NOV, OPEN_DEC],
      meta(),
    );
    await h.svc.onSessionCompleted(sessionOf(meta()));
    expect(h.inv("inv_dec").status).toBe("VOID");
    expect(h.sub()).toMatchObject({ catchupState: null, externalPayment: false });
    expect(h.inv("inv_a").status).toBe("PAID");
    expect(h.inv("inv_b").status).toBe("PAID");
    // a redelivery of the completion finds no claim: nothing more is voided
    await h.svc.onSessionCompleted(sessionOf(meta()));
    expect(h.voided()).toBe(1);
  });

  it("the walk is gone from the settle path: voidSupersededTx / settle read catchup_from + catchup_to and call NO coverage walk (no paidThroughOf, no paidCoverage)", () => {
    const src = fs.readFileSync(path.join(__dirname, "catchup-claim.service.ts"), "utf8");
    const from = src.indexOf("async settle(");
    const to = src.indexOf("// ─── the RELEASE path");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const settlePath = src.slice(from, to);
    expect(settlePath).not.toMatch(/paidThroughOf\(/);
    expect(settlePath).not.toMatch(/paidCoverage\(/);
    expect(settlePath).not.toMatch(/manualCoverage\(/);
    expect(settlePath).toMatch(/CATCHUP_META\.from|catchup_from/);
    expect(settlePath).toMatch(/CATCHUP_META\.to|catchup_to/);
  });

  it("settle follows the SESSION's S even when the PAID rows would walk elsewhere: S = Nov 1 voids [Nov 1, Dec 1) and [Dec 1, Jan 1) though a PAID row far out would make the walk refuse", async () => {
    const farPaid = row("inv_far", "PAID", "2027-03-01T12:00:00Z", "2027-04-01T12:00:00Z");
    const oct = row("inv_oct", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const nov = row("inv_nov", "OPEN", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z");
    const h = make(
      awaiting(),
      [oct, farPaid, nov, OPEN_DEC],
      meta({
        catchup_from: "2026-11-01T12:00:00.000Z",
        catchup_to: "2026-11-01T12:00:00.000Z",
      }),
    );
    await h.svc.settle(T, SUB);
    expect(h.inv("inv_nov").status).toBe("VOID");
    expect(h.inv("inv_dec").status).toBe("VOID");
    expect(h.inv("inv_far").status).toBe("PAID");
    expect(h.inv("inv_oct").status).toBe("PAID");
  });
});

describe("the void rule at settle (r9 rule 4): snapped end > S, no upper bound, PAID never touched", () => {
  it("PIN (r9 'RED' row, but master's rule already voids both): OPEN [Nov 1, Dec 1) issued early AND OPEN [Nov 29, Jan 1) merged are both voided on settle", async () => {
    const oct = row("inv_oct", "PAID", "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z");
    const early = row("inv_early", "OPEN", "2026-11-01T12:00:00Z", "2026-12-01T12:00:00Z");
    const merged = row("inv_merged", "OPEN", "2026-11-29T12:00:00Z", "2027-01-01T12:00:00Z");
    const h = make(
      awaiting(),
      [oct, early, merged],
      meta({ catchup_from: "2026-11-01T12:00:00.000Z", catchup_to: "2026-11-01T12:00:00.000Z" }),
    );
    await h.svc.settle(T, SUB);
    expect(h.inv("inv_early").status).toBe("VOID");
    expect(h.inv("inv_merged").status).toBe("VOID");
    expect(h.inv("inv_oct").status).toBe("PAID");
  });

  it("PIN: the straddle - PAID [Oct 1, Oct 10), OPEN [Oct 1, Nov 1) straddles S = Oct 10 and is voided; a replayed settle voids nothing more", async () => {
    const pre = row("inv_pre", "PAID", "2026-10-01T12:00:00Z", "2026-10-10T12:00:00Z");
    const straddle = row("inv_straddle", "OPEN", "2026-10-05T12:00:00Z", "2026-11-01T12:00:00Z");
    const m = meta({
      catchup: "period",
      catchup_shape: "trial_one_time",
      catchup_stub_cents: "22000",
      catchup_from: "2026-10-10T12:00:00.000Z",
      catchup_to: "2026-11-01T12:00:00.000Z",
    });
    const h = make(awaiting({ catchupInvoiceId: "in_ot" }), [pre, straddle], m, [
      { id: "in_ot", status: "paid", subscription: SUB, amountDue: 22000, amountPaid: 22000 },
    ]);
    expect(await h.svc.settle(T, SUB, null, "in_ot")).toBe(true);
    expect(h.inv("inv_straddle").status).toBe("VOID");
    expect(h.inv("inv_pre").status).toBe("PAID");
    expect(h.voided()).toBe(1);
    // replay: the claim is gone (claim CAS), and even a re-opened invoice is not voided again (status CAS)
    h.inv("inv_straddle").status = "OPEN";
    expect(await h.svc.settle(T, SUB, null, "in_ot")).toBe(false);
    expect(h.inv("inv_straddle").status).toBe("OPEN");
    expect(h.voided()).toBe(1);
  });

  it("PIN: settle reads the amount the session promised - a different amount HOLDS the claim and voids nothing", async () => {
    const m = meta({
      catchup: "period",
      catchup_shape: "trial_one_time",
      catchup_stub_cents: "22000",
      catchup_from: "2026-10-10T12:00:00.000Z",
      catchup_to: "2026-11-01T12:00:00.000Z",
    });
    const straddle = row("inv_straddle", "OPEN", "2026-10-05T12:00:00Z", "2026-11-01T12:00:00Z");
    const h = make(awaiting({ catchupInvoiceId: "in_ot" }), [straddle], m, [
      { id: "in_ot", status: "paid", subscription: SUB, amountDue: 21999, amountPaid: 21999 },
    ]);
    expect(await h.svc.settle(T, SUB, null, "in_ot")).toBe(false);
    expect(h.inv("inv_straddle").status).toBe("OPEN");
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });
});
