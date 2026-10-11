jest.mock("./coupon-state", () => ({
  applyCouponStateTx: jest.fn(async () => ({ applied: true, stale: false, amountDelta: 0 })),
}));
import * as fs from "fs";
import * as path from "path";
import { Logger } from "@nestjs/common";
import { CATCHUP_LATE_ALERT_DAYS } from "./catchup-claim";
import { CatchupClaimService } from "./catchup-claim.service";
import { applyCouponStateTx } from "./coupon-state";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { fakeStripeCatchup, type FakeInvoice } from "../testing/fake-stripe-catchup";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-733r3 N2 / r4 N2: the catch-up CLAIM lifecycle against an in-memory store and a stateful Stripe fake (no
 * network). The real-Postgres twin (CAS, the lock, markPaid) is catchup-claim.db.spec.ts.
 */

const NOW = new Date("2026-10-09T12:00:00Z");
const SESSION = "cs_1";
const SUB = "sub_1";

const octOpen = {
  id: "inv_oct",
  tenantId: "t1",
  status: "OPEN",
  number: "RF-2026-0001",
  periodStart: new Date("2026-10-01T12:00:00Z"),
  periodEnd: new Date("2026-11-01T12:00:00Z"),
  periodKey: "2026-10-01T12:00:00.000Z",
};
const novOpen = {
  id: "inv_nov",
  tenantId: "t1",
  status: "OPEN",
  number: "RF-2026-0002",
  periodStart: new Date("2026-11-01T12:00:00Z"),
  periodEnd: new Date("2026-12-01T12:00:00Z"),
  periodKey: "2026-11-01T12:00:00.000Z",
};
const octPaid = { ...octOpen, id: "inv_oct_paid", status: "PAID", periodKey: "x" };

/** Every fixture session expires at a FIXED instant: nothing in this spec reads the real clock (c). */
const SESSION_EXPIRES_AT = Math.floor(Date.parse("2026-10-10T10:00:00Z") / 1000);

const sessionOf = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  customer: "cus_1",
  subscription: SUB,
  payment_status: "unpaid",
  expires_at: SESSION_EXPIRES_AT,
  metadata: { tenantId: "t1", catchup: "period", ...(over.metadata as object) },
  ...over,
});

function make(
  sub: Record<string, unknown> = {},
  invoices: Record<string, unknown>[] = [octOpen],
  stripeSeed: {
    invoices?: FakeInvoice[];
    sessions?: Record<string, any>;
    subs?: Record<string, any>;
  } = {},
) {
  const db = fakeCatchupDb({ subs: [{ tenantId: "t1", ...sub }], invoices });
  const stripe = fakeStripeCatchup({
    subs: {
      [SUB]: { id: SUB, customer: "cus_1", latest_invoice: null, default_payment_method: "pm_1" },
    },
    ...stripeSeed,
    // The settle verification reads the claim's Checkout session (its subscription must be the stored one).
    sessions: {
      [SESSION]: {
        id: SESSION,
        subscription: SUB,
        status: "complete",
        metadata: { tenantId: "t1", catchup: "period" },
      },
      ...stripeSeed.sessions,
    },
  });
  const events = { emit: jest.fn() };
  const svc = new CatchupClaimService(db.prisma, stripe as any, events as any);
  return {
    events,
    db,
    stripe,
    svc,
    sub: () => db.subs[0],
    inv: (id: string) => db.invoices.find((i) => i.id === id)!,
  };
}

/** A manual tenant whose card checkout has COMPLETED and whose settling invoice is `in_1`. */
const awaiting = (over: Record<string, unknown> = {}) => ({
  stripeSubId: SUB,
  externalPayment: false,
  catchupState: "AWAITING_FIRST_PAYMENT",
  catchupSessionId: SESSION,
  catchupInvoiceId: "in_1",
  ...over,
});

describe("opening and aborting a claim", () => {
  it("openClaim writes SESSION_OPEN under the Tenant lock before anything else", async () => {
    const h = make();
    await h.svc.openClaim("t1");
    expect(h.sub().catchupState).toBe("SESSION_OPEN");
    expect(h.db.locks).toEqual(["t1"]); // the Tenant FOR UPDATE, first
    expect(h.stripe.calls).toEqual([]); // not one Stripe call yet
  });

  it("refuses a tenant that already holds a claim: SESSION_OPEN -> CATCHUP_SESSION_OPEN, later states -> CATCHUP_PENDING", async () => {
    const open = make({ catchupState: "SESSION_OPEN" });
    await expect(open.svc.openClaim("t1")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_SESSION_OPEN },
    });
    for (const state of ["AWAITING_FIRST_PAYMENT", "RELEASING"]) {
      const h = make({ catchupState: state });
      await expect(h.svc.openClaim("t1")).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.CATCHUP_PENDING },
      });
    }
  });

  it("refuses a tenant that already has a Stripe subscription (census) or is not on manual invoicing", async () => {
    await expect(make({ stripeSubId: "sub_x" }).svc.openClaim("t1")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_NEEDS_RULING }, // r5: an existing stripeSubId is a ruling item
    });
    await expect(make({ externalPayment: false }).svc.openClaim("t1")).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE },
    });
  });

  it("attachSession stores the id only on a SESSION_OPEN claim without one; abortClaim drops that claim", async () => {
    const h = make();
    await h.svc.openClaim("t1");
    await h.svc.attachSession("t1", SESSION);
    expect(h.sub().catchupSessionId).toBe(SESSION);
    await h.svc.attachSession("t1", "cs_other");
    expect(h.sub().catchupSessionId).toBe(SESSION); // CAS: never overwritten
    await h.svc.abortClaim("t1");
    expect(h.sub().catchupState).toBe("SESSION_OPEN"); // a stored session id means a session exists: not aborted

    const h2 = make();
    await h2.svc.openClaim("t1");
    await h2.svc.abortClaim("t1"); // Stripe create failed
    expect(h2.sub().catchupState).toBeNull();
  });
});

describe("checkout.session.completed (the claim advances; nothing is voided yet)", () => {
  it("SESSION_OPEN -> AWAITING_FIRST_PAYMENT, externalPayment=false, RfInvoices still OPEN (an ACH completion is unpaid)", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [
      octOpen,
      novOpen,
    ]);
    await h.svc.onSessionCompleted(sessionOf());
    expect(h.sub()).toMatchObject({
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupSessionId: SESSION,
      externalPayment: false,
    });
    expect(h.inv("inv_oct").status).toBe("OPEN"); // never voided at completion
    expect(h.inv("inv_nov").status).toBe("OPEN");
  });

  it("a session the ordinary completion did NOT apply (another subscription stored) advances nothing", async () => {
    const h = make({
      stripeSubId: "sub_other",
      catchupState: "SESSION_OPEN",
      catchupSessionId: SESSION,
    });
    await h.svc.onSessionCompleted(sessionOf());
    expect(h.sub().catchupState).toBe("SESSION_OPEN");
    expect(h.sub().externalPayment).toBe(true);
  });

  it("adopts the session id when the claim never stored it (a crash after Stripe created the session)", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: null });
    await h.svc.onSessionCompleted(sessionOf());
    expect(h.sub()).toMatchObject({
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupSessionId: SESSION,
    });
  });

  it("another session's completion cannot advance this claim", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: "cs_mine" });
    await h.svc.onSessionCompleted(sessionOf({ id: "cs_other" }));
    expect(h.sub().catchupState).toBe("SESSION_OPEN");
  });

  it("a non-catch-up session is ignored", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION });
    await h.svc.onSessionCompleted({
      id: SESSION,
      subscription: SUB,
      metadata: { tenantId: "t1" },
    });
    expect(h.sub().catchupState).toBe("SESSION_OPEN");
  });

  it("trial branch: the stub invoice is created as a DRAFT with automatically_finalizes_at, its id is persisted BEFORE its item exists, key (tenant, trial-stub, session)", async () => {
    const finalizeAt = Math.floor(Date.parse("2026-11-14T12:00:00Z") / 1000);
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [
      octPaid,
    ]);
    const idAtItemTime: (string | null)[] = [];
    h.stripe.client.invoiceItems.create.mockImplementationOnce(async (params: any) => {
      idAtItemTime.push(h.sub().catchupInvoiceId); // what the claim stored when the item was created
      h.stripe.calls.push("invoiceItems.create");
      return { id: "ii_1", invoice: params.invoice, metadata: params.metadata ?? {} };
    });

    await h.svc.onSessionCompleted(
      sessionOf({
        metadata: {
          tenantId: "t1",
          catchup: "prepaid",
          catchup_shape: "trial",
          catchup_stub_cents: "17000",
          catchup_stub_label: "Subscription — November 2026 (from Nov 14)",
          catchup_finalize_at: String(finalizeAt),
        },
      }),
    );

    const created = h.stripe.client.invoices.create.mock.calls[0];
    expect(created[0]).toMatchObject({
      subscription: SUB,
      auto_advance: true,
      default_payment_method: "pm_1",
      automatically_finalizes_at: finalizeAt,
      metadata: { catchup_for: SESSION },
    });
    expect(created[1]).toEqual({ idempotencyKey: `t1:trial-stub:${SESSION}` });
    expect(idAtItemTime).toEqual([h.sub().catchupInvoiceId]);
    expect(h.sub().catchupInvoiceId).toMatch(/^in_stub/);
    expect(h.stripe.client.invoiceItems.create.mock.calls[0][0]).toMatchObject({
      amount: 17000,
      currency: "usd",
      invoice: h.sub().catchupInvoiceId,
    });
    expect(h.stripe.calls.indexOf("invoices.create")).toBeLessThan(
      h.stripe.calls.indexOf("invoiceItems.create"),
    );
  });

  it("a $0 trial invoice is never the settling one: with no stub the claim waits for the first invoice with money", async () => {
    const h = make(
      { stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octPaid],
      {
        invoices: [
          { id: "in_trial0", status: "paid", subscription: SUB, amountDue: 0, amountPaid: 0 },
        ],
        subs: { [SUB]: { id: SUB, customer: "cus_1", latest_invoice: "in_trial0" } },
      },
    );
    await h.svc.onSessionCompleted(sessionOf());
    expect(h.sub().catchupInvoiceId).toBeNull();
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });

  it("the first invoice (with money) is recorded, and if it is ALREADY paid the claim settles on the spot (r4 N2(c))", async () => {
    const h = make(
      { stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octOpen, novOpen],
      {
        invoices: [
          { id: "in_1", status: "paid", subscription: SUB, amountDue: 31000, amountPaid: 31000 },
        ],
        subs: { [SUB]: { id: SUB, customer: "cus_1", latest_invoice: "in_1" } },
      },
    );
    await h.svc.onSessionCompleted(sessionOf({ payment_status: "paid" }));
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.inv("inv_nov").status).toBe("VOID");
    expect(h.sub()).toMatchObject({
      catchupState: null,
      catchupSessionId: null,
      catchupInvoiceId: null,
    });
  });

  it("is idempotent: a redelivery changes nothing", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION });
    await h.svc.onSessionCompleted(sessionOf());
    const first = { ...h.sub() };
    await h.svc.onSessionCompleted(sessionOf());
    expect(h.sub()).toMatchObject({
      catchupState: first.catchupState,
      catchupSessionId: first.catchupSessionId,
    });
  });
});

describe("invoice.paid settles the claim (and only that)", () => {
  const paidInvoice = (over: Record<string, unknown> = {}) => ({
    id: "in_1",
    amount_paid: 31000,
    parent: { subscription_details: { subscription: SUB } },
    ...over,
  });

  it("the claim's invoice: OPEN RfInvoices from paid-through on are VOID once, the PAID one is untouched, the claim clears", async () => {
    const h = make(awaiting(), [octOpen, novOpen]);
    await h.svc.onInvoicePaid(paidInvoice());
    expect(h.inv("inv_oct")).toMatchObject({
      status: "VOID",
      periodKey: `${octOpen.periodKey}:void:inv_oct`,
    });
    expect(h.inv("inv_nov").status).toBe("VOID");
    expect(h.sub()).toMatchObject({
      catchupState: null,
      catchupSessionId: null,
      catchupInvoiceId: null,
    });
    const voidedAudits = h.db.audits.filter((a) => a.action === "RF_INVOICE_VOIDED");
    expect(voidedAudits).toHaveLength(2);
    // a replay is a no-op: no claim left to settle, no second audit row
    await h.svc.onInvoicePaid(paidInvoice());
    expect(h.db.audits.filter((a) => a.action === "RF_INVOICE_VOIDED")).toHaveLength(2);
  });

  it("October already PAID: only the OPEN November invoice (period from paid-through on) is voided", async () => {
    const h = make(awaiting(), [octPaid, novOpen]);
    await h.svc.onInvoicePaid(paidInvoice());
    expect(h.inv("inv_oct_paid").status).toBe("PAID");
    expect(h.inv("inv_nov").status).toBe("VOID");
  });

  it("r4 N1: the invoice's subscription must EQUAL the row's non-null stripeSubId (read via the dahlia-aware helper)", async () => {
    const h = make(awaiting());
    await h.svc.onInvoicePaid(
      paidInvoice({ parent: { subscription_details: { subscription: "sub_other" } } }),
    );
    await h.svc.onInvoicePaid(paidInvoice({ parent: null }));
    await h.svc.onInvoicePaid(paidInvoice({ parent: undefined, subscription: SUB })); // legacy top-level: accepted
    expect(h.inv("inv_oct").status).toBe("VOID"); // only the last one settled
    const g = make(awaiting());
    await g.svc.onInvoicePaid(
      paidInvoice({ parent: { subscription_details: { subscription: "sub_other" } } }),
    );
    expect(g.inv("inv_oct").status).toBe("OPEN");
    expect(g.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });

  it("a row with no stripeSubId is never matched by a null subscription", async () => {
    const h = make({ ...awaiting(), stripeSubId: null });
    await h.svc.onInvoicePaid(paidInvoice({ parent: null }));
    expect(h.inv("inv_oct").status).toBe("OPEN");
  });

  it("another invoice of the subscription (not the claim's) is ignored", async () => {
    const h = make(awaiting());
    await h.svc.onInvoicePaid(paidInvoice({ id: "in_other" }));
    expect(h.inv("inv_oct").status).toBe("OPEN");
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });

  it("the $0 trial invoice paid at completion is ignored (no catchupInvoiceId stored yet, amount_paid 0)", async () => {
    const h = make(awaiting({ catchupInvoiceId: null }));
    await h.svc.onInvoicePaid(paidInvoice({ id: "in_trial0", amount_paid: 0 }));
    expect(h.inv("inv_oct").status).toBe("OPEN");
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });

  it("with no invoice stored yet, the first invoice with money is adopted and settles the claim", async () => {
    const h = make(awaiting({ catchupInvoiceId: null }));
    await h.svc.onInvoicePaid(paidInvoice({ id: "in_first" }));
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.sub().catchupState).toBeNull();
  });

  it("a RELEASING claim is left to the release (its Step 0 handles a paid invoice)", async () => {
    const h = make(awaiting({ catchupState: "RELEASING" }));
    await h.svc.onInvoicePaid(paidInvoice());
    expect(h.inv("inv_oct").status).toBe("OPEN");
    expect(h.sub().catchupState).toBe("RELEASING");
  });

  it("a PAID RfInvoice after a gap voids NOTHING, says NEEDS RULING, and still clears the claim (the customer paid)", async () => {
    const gap = {
      ...novOpen,
      id: "inv_dec",
      status: "PAID",
      periodStart: new Date("2026-12-01T12:00:00Z"),
      periodEnd: new Date("2027-01-01T12:00:00Z"),
    };
    const h = make(awaiting(), [octPaid, gap, novOpen]);
    await h.svc.onInvoicePaid(paidInvoice());
    expect(h.inv("inv_nov").status).toBe("OPEN");
    expect(h.sub().catchupState).toBeNull();
    expect(h.db.audits.some((a) => a.meta?.kind === "billing_catchup_needs_ruling")).toBe(true);
  });

  it("takes the Tenant lock before it writes", async () => {
    const h = make(awaiting());
    await h.svc.onInvoicePaid(paidInvoice());
    expect(h.db.locks).toContain("t1");
  });
});

describe("checkout.session.expired (r4 #8)", () => {
  it("releases a SESSION_OPEN claim by CAS on the session id", async () => {
    const h = make({ catchupState: "SESSION_OPEN", catchupSessionId: SESSION });
    await h.svc.onSessionExpired(sessionOf());
    expect(h.sub()).toMatchObject({ catchupState: null, catchupSessionId: null });
    expect(h.sub().stripeSubId).toBeNull();
    expect(h.inv("inv_oct").status).toBe("OPEN"); // RfInvoices untouched
  });

  it("never releases a session that COMPLETED (AWAITING_FIRST_PAYMENT) - an expired event after completion changes nothing", async () => {
    const h = make(awaiting());
    await h.svc.onSessionExpired(sessionOf());
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
    expect(h.sub().stripeSubId).toBe(SUB);
  });

  it("a different session's expiry does not release this claim", async () => {
    const h = make({ catchupState: "SESSION_OPEN", catchupSessionId: "cs_mine" });
    await h.svc.onSessionExpired(sessionOf({ id: "cs_old" }));
    expect(h.sub().catchupState).toBe("SESSION_OPEN");
  });

  it("an unstored session id is not released by an event (only the orphan sweep does)", async () => {
    const h = make({ catchupState: "SESSION_OPEN", catchupSessionId: null });
    await h.svc.onSessionExpired(sessionOf());
    expect(h.sub().catchupState).toBe("SESSION_OPEN");
  });
});

describe("the release order (r4 N2(b))", () => {
  const unpaid = (over: Partial<FakeInvoice> = {}): FakeInvoice => ({
    id: "in_1",
    status: "open",
    subscription: SUB,
    amountDue: 31000,
    attemptCount: 3,
    nextPaymentAttempt: null,
    ...over,
  });

  it("Step 0 re-read -> RELEASING -> release tx -> Step 2 void the settling invoice -> Step 3 cancel -> Step 4 clear", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [unpaid()],
      sessions: { [SESSION]: { id: SESSION, subscription: SUB, status: "complete" } },
    });
    const seenAtVoid: Record<string, unknown>[] = [];
    h.stripe.voidInvoice.mockImplementationOnce(async (id: string) => {
      seenAtVoid.push({ ...h.sub() }); // what the row looked like when Stripe was asked to void
      h.stripe.calls.push(`voidInvoice:${id}`);
      h.stripe.invoices.get(id)!.status = "void";
      return { id, status: "void" };
    });

    const out = await h.svc.release("t1", { sessionId: SESSION, reason: "test" });

    expect(out).toBe("released");
    expect(h.stripe.calls.filter((c) => !c.startsWith("getCheckoutSession"))).toEqual([
      "getInvoiceFacts:in_1", // Step 0
      "getInvoiceFacts:in_1", // Step 2 reads before it voids
      "voidInvoice:in_1", // Step 2
      "cancelSubscription:sub_1", // Step 3
    ]);
    // the release tx had ALREADY run when Stripe was asked to void: manual again, RELEASING, ids kept
    expect(seenAtVoid[0]).toMatchObject({
      stripeSubId: null,
      externalPayment: true,
      catchupState: "RELEASING",
      catchupSessionId: SESSION,
      catchupInvoiceId: "in_1",
    });
    // Step 4
    expect(h.sub()).toMatchObject({
      catchupState: null,
      catchupSessionId: null,
      catchupInvoiceId: null,
    });
    // the cancel carries no proration and no final invoice
    expect(h.stripe.cancelSubscription.mock.calls[0][1]).toEqual({
      prorate: false,
      invoice_now: false,
    });
    // the RfInvoices are untouched: the manual tenant is invoiced by hand again
    expect(h.inv("inv_oct").status).toBe("OPEN");
  });

  it("Step 0: the invoice turned out PAID -> the paid path (RfInvoices void, nothing cancelled, nothing released)", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [unpaid({ status: "paid", amountPaid: 31000 })],
    });
    const out = await h.svc.release("t1", { sessionId: SESSION, reason: "test" });
    expect(out).toBe("settled");
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.sub().stripeSubId).toBe(SUB);
    expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(h.stripe.voidInvoice).not.toHaveBeenCalled();
  });

  it("Step 0: a payment still PROCESSING (ACH) -> nothing is released", async () => {
    const h = make(awaiting(), [octOpen], { invoices: [unpaid({ processing: true })] });
    const out = await h.svc.release("t1", { sessionId: SESSION, reason: "test" });
    expect(out).toBe("deferred");
    expect(h.sub()).toMatchObject({
      catchupState: "AWAITING_FIRST_PAYMENT",
      stripeSubId: SUB,
      externalPayment: false,
    });
    expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it("Step 2 refused because the invoice became PAID: the subscription is NOT cancelled, NEEDS RULING, the claim stays RELEASING", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [unpaid()],
      sessions: { [SESSION]: { id: SESSION, subscription: SUB, status: "complete" } },
    });
    h.stripe.voidInvoice.mockImplementationOnce(async (id: string) => {
      h.stripe.invoices.get(id)!.status = "paid"; // paid in the instant between the read and the void
      throw new Error("invoice is paid and cannot be voided");
    });
    const out = await h.svc.release("t1", { sessionId: SESSION, reason: "test" });
    expect(out).toBe("needs_ruling");
    expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(h.sub().catchupState).toBe("RELEASING");
    expect(h.db.audits.some((a) => a.meta?.kind === "billing_catchup_release_refused_paid")).toBe(
      true,
    );
  });

  it("a DRAFT stub invoice is deleted, not voided", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [unpaid({ status: "draft" })],
      sessions: { [SESSION]: { id: SESSION, subscription: SUB, status: "complete" } },
    });
    await h.svc.release("t1", { sessionId: SESSION, reason: "test" });
    expect(h.stripe.deleteDraftInvoice).toHaveBeenCalledWith("in_1");
    expect(h.stripe.voidInvoice).not.toHaveBeenCalled();
    expect(h.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it("a Stripe failure mid-release leaves RELEASING (ids kept) for the sweep, and a re-run finishes it", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [unpaid()],
      sessions: { [SESSION]: { id: SESSION, subscription: SUB, status: "complete" } },
    });
    h.stripe.voidInvoice.mockRejectedValueOnce(new Error("stripe 503"));
    await expect(h.svc.release("t1", { sessionId: SESSION, reason: "test" })).rejects.toThrow(
      "stripe 503",
    );
    expect(h.sub()).toMatchObject({
      catchupState: "RELEASING",
      stripeSubId: null,
      externalPayment: true,
      catchupInvoiceId: "in_1",
    });

    const sweep = await h.svc.sweep(NOW);
    expect(sweep.releasing).toBe(1);
    expect(h.sub().catchupState).toBeNull();
    expect(h.stripe.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it("a claim that moved while Stripe was being read is not released (the CAS sees the change)", async () => {
    const h = make(awaiting(), [octOpen], { invoices: [unpaid()] });
    h.stripe.getInvoiceFacts.mockImplementationOnce(async () => {
      h.sub().catchupInvoiceId = "in_moved"; // another writer changed the claim during the Stripe read
      return {
        status: "open",
        amountPaid: 0,
        amountDue: 31000,
        paymentProcessing: false,
        nextPaymentAttempt: null,
        attemptCount: 3,
        subscriptionId: SUB,
      };
    });
    const out = await h.svc.release("t1", { sessionId: SESSION, reason: "test" });
    expect(out).toBe("none");
    expect(h.sub().stripeSubId).toBe(SUB);
    expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it("no claim / another session's claim: nothing happens", async () => {
    const h = make();
    expect(await h.svc.release("t1", { reason: "x" })).toBe("none");
    const g = make(awaiting());
    expect(await g.svc.release("t1", { sessionId: "cs_other", reason: "x" })).toBe("none");
    expect(g.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });
});

describe("invoice.payment_failed releases only a DEFINITIVE failure", () => {
  const failed = { id: "in_1", parent: { subscription_details: { subscription: SUB } } };

  it("Stripe will retry (next_payment_attempt set): the claim is kept", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [
        {
          id: "in_1",
          status: "open",
          subscription: SUB,
          amountDue: 100,
          attemptCount: 1,
          nextPaymentAttempt: 1791172800,
        },
      ],
    });
    await h.svc.onPaymentFailed(failed);
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
    expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it("no further attempt: released (sub cancelled, RfInvoices untouched, manual invoicing resumes)", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [
        {
          id: "in_1",
          status: "open",
          subscription: SUB,
          amountDue: 100,
          attemptCount: 4,
          nextPaymentAttempt: null,
        },
      ],
      sessions: { [SESSION]: { id: SESSION, subscription: SUB, status: "complete" } },
    });
    await h.svc.onPaymentFailed(failed);
    expect(h.sub()).toMatchObject({ catchupState: null, stripeSubId: null, externalPayment: true });
    expect(h.stripe.cancelSubscription).toHaveBeenCalledWith(
      SUB,
      { prorate: false, invoice_now: false },
      expect.anything(),
    );
    expect(h.inv("inv_oct").status).toBe("OPEN");
  });

  it("a failure of an unrelated invoice, or a PROCESSING ACH payment, never releases", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [
        {
          id: "in_1",
          status: "open",
          subscription: SUB,
          amountDue: 100,
          attemptCount: 1,
          nextPaymentAttempt: null,
          processing: true,
        },
      ],
    });
    await h.svc.onPaymentFailed(failed);
    await h.svc.onPaymentFailed({ ...failed, id: "in_unrelated" });
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });
});

describe("the hourly sweep", () => {
  it("SESSION_OPEN whose session Stripe says EXPIRED -> released", async () => {
    const h = make({ catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [octOpen], {
      sessions: {
        [SESSION]: {
          id: SESSION,
          status: "expired",
          metadata: { tenantId: "t1", catchup: "period" },
        },
      },
    });
    await h.svc.sweep(NOW);
    expect(h.sub().catchupState).toBeNull();
  });

  it("SESSION_OPEN whose session is still open is left alone; a COMPLETE session is advanced, never released", async () => {
    const open = make({ catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [octOpen], {
      sessions: {
        [SESSION]: {
          id: SESSION,
          status: "open",
          metadata: { tenantId: "t1", catchup: "period" },
        },
      },
    });
    await open.svc.sweep(NOW);
    expect(open.sub().catchupState).toBe("SESSION_OPEN");

    const done = make(
      { stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octOpen],
      {
        sessions: {
          [SESSION]: {
            id: SESSION,
            status: "complete",
            subscription: SUB,
            metadata: { tenantId: "t1", catchup: "period" },
          },
        },
      },
    );
    await done.svc.sweep(NOW);
    expect(done.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
    expect(done.sub().stripeSubId).toBe(SUB);
  });

  it("a session id that was never stored: released only after 25 h", async () => {
    const young = make({
      catchupState: "SESSION_OPEN",
      catchupSessionId: null,
      updatedAt: new Date(NOW.getTime() - 24 * 3600_000),
    });
    await young.svc.sweep(NOW);
    expect(young.sub().catchupState).toBe("SESSION_OPEN");
    const old = make({
      catchupState: "SESSION_OPEN",
      catchupSessionId: null,
      updatedAt: new Date(NOW.getTime() - 26 * 3600_000),
    });
    await old.svc.sweep(NOW);
    expect(old.sub().catchupState).toBeNull();
  });

  it("AWAITING_FIRST_PAYMENT: paid -> settled", async () => {
    const h = make(awaiting(), [octOpen], {
      invoices: [
        { id: "in_1", status: "paid", subscription: SUB, amountDue: 100, amountPaid: 100 },
      ],
    });
    await h.svc.sweep(NOW);
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.sub().catchupState).toBeNull();
  });

  it("AWAITING_FIRST_PAYMENT: definitively failed -> released; still being retried -> left", async () => {
    const failed = make(awaiting(), [octOpen], {
      invoices: [{ id: "in_1", status: "uncollectible", subscription: SUB, amountDue: 100 }],
      sessions: { [SESSION]: { id: SESSION, subscription: SUB, status: "complete" } },
    });
    await failed.svc.sweep(NOW);
    expect(failed.sub().catchupState).toBeNull();
    expect(failed.sub().externalPayment).toBe(true);

    const retrying = make(awaiting(), [octOpen], {
      invoices: [
        {
          id: "in_1",
          status: "open",
          subscription: SUB,
          amountDue: 100,
          attemptCount: 1,
          nextPaymentAttempt: 1791172800,
        },
      ],
    });
    await retrying.svc.sweep(NOW);
    expect(retrying.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });

  it("AWAITING with no invoice stored: finds the first invoice with money, adopts it, settles when paid", async () => {
    const h = make(awaiting({ catchupInvoiceId: null }), [octOpen], {
      invoices: [
        { id: "in_trial0", status: "paid", subscription: SUB, amountDue: 0, amountPaid: 0 },
        { id: "in_real", status: "paid", subscription: SUB, amountDue: 31000, amountPaid: 31000 },
      ],
    });
    await h.svc.sweep(NOW);
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.sub().catchupState).toBeNull();
  });

  it("one tenant failing does not stop the next", async () => {
    const db = fakeCatchupDb({
      subs: [
        { tenantId: "ta", ...awaiting({ catchupInvoiceId: "in_a" }) },
        {
          tenantId: "tb",
          ...awaiting({ stripeSubId: "sub_b", catchupSessionId: "cs_b", catchupInvoiceId: "in_b" }),
        },
      ],
      invoices: [
        { ...octOpen, id: "ia", tenantId: "ta" },
        { ...octOpen, id: "ib", tenantId: "tb" },
      ],
    });
    const stripe = fakeStripeCatchup({
      invoices: [
        { id: "in_b", status: "paid", subscription: "sub_b", amountDue: 100, amountPaid: 100 },
      ],
      sessions: { cs_b: { id: "cs_b", subscription: "sub_b", status: "complete" } },
    });
    const svc = new CatchupClaimService(db.prisma, stripe as any, { emit: jest.fn() } as any);
    stripe.getInvoiceFacts.mockImplementationOnce(async () => {
      throw new Error("stripe 500");
    });
    const out = await svc.sweep(NOW);
    expect(out.errors).toBe(1);
    expect(db.invoices.find((i) => i.id === "ib")!.status).toBe("VOID");
  });
});

describe("SA-733r5 trial_one_time (catchup=period): the claim around a trialing subscription", () => {
  const SHAPE_META = {
    tenantId: "t1",
    catchup: "period",
    catchup_shape: "trial_one_time",
    catchup_stub_cents: "31000",
    catchup_from: "2026-10-01T12:00:00.000Z",
    catchup_to: "2026-11-01T12:00:00.000Z",
  };
  const novOpenR5 = novOpen;
  const open = (over: Record<string, unknown> = {}) => ({
    stripeSubId: SUB,
    catchupState: "SESSION_OPEN",
    catchupSessionId: SESSION,
    ...over,
  });

  it("completion: the settling invoice is `session.invoice` (it carries the one-time line), persisted BEFORE it can be paid; externalPayment=false", async () => {
    const h = make(open(), [octOpen, novOpenR5], {
      invoices: [
        { id: "in_ot", status: "open", subscription: SUB, amountDue: 31000, attemptCount: 0 },
      ],
      subs: { [SUB]: { id: SUB, customer: "cus_1", status: "trialing", latest_invoice: "in_ot" } },
    });
    await h.svc.onSessionCompleted(sessionOf({ invoice: "in_ot", metadata: SHAPE_META }));
    expect(h.sub()).toMatchObject({
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupInvoiceId: "in_ot",
      externalPayment: false,
    });
    expect(h.inv("inv_oct").status).toBe("OPEN"); // nothing voided until it is PAID
    expect(h.stripe.client.invoices.create).not.toHaveBeenCalled(); // no post-completion stub in this shape
  });

  it("falls back to the subscription's latest invoice when the session names none", async () => {
    const h = make(open(), [octOpen], {
      invoices: [{ id: "in_l", status: "open", subscription: SUB, amountDue: 31000 }],
      subs: { [SUB]: { id: SUB, customer: "cus_1", status: "trialing", latest_invoice: "in_l" } },
    });
    await h.svc.onSessionCompleted(sessionOf({ metadata: SHAPE_META }));
    expect(h.sub().catchupInvoiceId).toBe("in_l");
  });

  it("settle: the one-time invoice PAID => claim cleared, October AND November voided exactly once; a replay voids nothing more", async () => {
    const h = make({ ...awaiting(), catchupInvoiceId: "in_ot" }, [
      octOpen,
      novOpen,
      {
        ...novOpen,
        id: "inv_dec",
        periodStart: new Date("2026-12-01T12:00:00Z"),
        periodEnd: new Date("2027-01-01T12:00:00Z"),
        periodKey: "kd",
      },
    ]);
    const paid = {
      id: "in_ot",
      amount_paid: 31000,
      parent: { subscription_details: { subscription: SUB } },
    };
    await h.svc.onInvoicePaid(paid);
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.inv("inv_nov").status).toBe("VOID");
    expect(h.inv("inv_dec").status).toBe("VOID"); // anything ending after paid-through is superseded
    expect(h.sub()).toMatchObject({ catchupState: null, catchupInvoiceId: null });
    const voids = () => h.db.audits.filter((a) => a.action === "RF_INVOICE_VOIDED").length;
    expect(voids()).toBe(3);
    await h.svc.onInvoicePaid(paid);
    expect(voids()).toBe(3);
  });

  it("release (ACH return / decline): no pastDue stamp, the TRIALING sub is cancelled, externalPayment=true, RfInvoices stay OPEN", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_ot" }), [octOpen, novOpen], {
      invoices: [
        {
          id: "in_ot",
          status: "open",
          subscription: SUB,
          amountDue: 31000,
          attemptCount: 2,
          nextPaymentAttempt: null,
        },
      ],
      sessions: { [SESSION]: { id: SESSION, subscription: SUB, status: "complete" } },
      subs: { [SUB]: { id: SUB, status: "trialing" } },
    });
    await h.svc.onPaymentFailed({
      id: "in_ot",
      parent: { subscription_details: { subscription: SUB } },
    });
    expect(h.stripe.subs[SUB].status).toBe("canceled"); // it can never start charging at A
    expect(h.stripe.calls).toEqual(
      expect.arrayContaining([`voidInvoice:in_ot`, `cancelSubscription:${SUB}`]),
    );
    expect(h.sub()).toMatchObject({
      stripeSubId: null,
      externalPayment: true,
      catchupState: null,
    });
    expect(h.sub().pastDueSince).toBeUndefined(); // nothing stamped a dunning clock
    expect(h.inv("inv_oct").status).toBe("OPEN");
    expect(h.inv("inv_nov").status).toBe("OPEN");
  });
});

describe("b2b review: the release resets the coupon columns THROUGH coupon-state.ts", () => {
  it("applyCouponStateTx(NO_COUPON) runs in the release tx, with the Tenant lock held, only when the release tx wrote", async () => {
    (applyCouponStateTx as jest.Mock).mockClear();
    const h = make(awaiting(), [octOpen], {
      invoices: [
        { id: "in_1", status: "open", subscription: SUB, amountDue: 100, attemptCount: 3 },
      ],
      sessions: { [SESSION]: { id: SESSION, subscription: SUB, status: "complete" } },
    });
    await h.svc.release("t1", { sessionId: SESSION, reason: "test" });
    expect(applyCouponStateTx).toHaveBeenCalledTimes(1);
    const [, , tenantId, state, opts] = (applyCouponStateTx as jest.Mock).mock.calls[0];
    expect(tenantId).toBe("t1");
    expect(state).toEqual({ full: false, couponId: null, endsAt: null });
    expect(opts).toMatchObject({ reason: "catchup_released", tenantLockHeld: true });
  });

  it("a SESSION_OPEN release (no subscription yet) writes no coupon state", async () => {
    (applyCouponStateTx as jest.Mock).mockClear();
    const h = make({ catchupState: "SESSION_OPEN", catchupSessionId: SESSION });
    await h.svc.release("t1", { sessionId: SESSION, reason: "test" });
    expect(applyCouponStateTx).not.toHaveBeenCalled();
  });
});

describe("ruling (item 8): there is NO ordinary-conversion void — only a settled catch-up voids RfInvoices", () => {
  const first = {
    id: "in_first",
    amount_paid: 31000,
    billing_reason: "subscription_create",
    parent: { subscription_details: { subscription: SUB } },
  };

  it("an invoice.paid for a manual-flagged tenant's subscription with NO held claim voids nothing, whatever the flags", async () => {
    for (const sub of [
      { stripeSubId: SUB, externalPayment: true },
      { stripeSubId: SUB, externalPayment: false },
    ]) {
      const h = make(sub, [octPaid, novOpen]);
      await h.svc.onInvoicePaid(first);
      expect(h.inv("inv_nov").status).toBe("OPEN");
      expect(h.db.audits.filter((a) => a.action === "RF_INVOICE_VOIDED")).toHaveLength(0);
    }
  });

  it("the service no longer exposes an ordinary-conversion path, and the void writer runs only from settle", () => {
    expect((CatchupClaimService.prototype as any).onOrdinaryConversionPaid).toBeUndefined();
    const src = fs.readFileSync(path.join(__dirname, "catchup-claim.service.ts"), "utf8");
    const calls = [...src.matchAll(/this\.voidSupersededTx\(/g)];
    expect(calls).toHaveLength(1);
    const settleAt = src.indexOf("async settle(");
    const releaseAt = src.indexOf("// ─── the RELEASE path");
    expect(calls[0].index!).toBeGreaterThan(settleAt);
    expect(calls[0].index!).toBeLessThan(src.indexOf("private async voidSupersededTx"));
    expect(releaseAt).toBeGreaterThan(calls[0].index!);
  });

  it("a successful settlement CLEARS externalPayment (so B3 dunning applies later), not only the completion", async () => {
    const h = make(
      { ...awaiting({ catchupInvoiceId: "in_1" }), externalPayment: true },
      [octOpen],
      {
        invoices: [
          { id: "in_1", status: "paid", subscription: SUB, amountDue: 100, amountPaid: 100 },
        ],
      },
    );
    await h.svc.onInvoicePaid({
      id: "in_1",
      amount_paid: 100,
      parent: { subscription_details: { subscription: SUB } },
    });
    expect(h.sub()).toMatchObject({ externalPayment: false, catchupState: null });
  });
});

describe("Opus B1: a claim settles only on the subscription its OWN session created", () => {
  const ordinaryPaid = {
    id: "in_ord",
    amount_paid: 12000,
    billing_reason: "subscription_create",
    parent: { subscription_details: { subscription: "sub_ord" } },
  };

  it("SESSION_OPEN + an ORDINARY sub's paid first invoice: nothing is adopted, nothing voided, the claim stays", async () => {
    // the tenant clicked 'Complete payment' while the catch-up session was open; its D6 sub is the stored one
    const h = make(
      { stripeSubId: "sub_ord", catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octOpen, novOpen],
    );
    await h.svc.onInvoicePaid(ordinaryPaid);
    expect(h.inv("inv_oct").status).toBe("OPEN");
    expect(h.inv("inv_nov").status).toBe("OPEN");
    expect(h.sub()).toMatchObject({
      catchupState: "SESSION_OPEN",
      catchupSessionId: SESSION,
      catchupInvoiceId: null, // NOT adopted
    });
    expect(h.db.audits.filter((a) => a.action === "RF_INVOICE_VOIDED")).toHaveLength(0);
  });

  it("settle() called directly (sweep / release) for a foreign subscription also voids nothing", async () => {
    const h = make(
      { stripeSubId: "sub_ord", catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octOpen],
    );
    expect(await h.svc.settle("t1", "sub_ord")).toBe(false);
    expect(h.inv("inv_oct").status).toBe("OPEN");
  });

  it("SESSION_OPEN whose own subscription is stored (invoice.paid beat the completion hook) DOES settle", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [
      octOpen,
    ]);
    await h.svc.onInvoicePaid({
      id: "in_own",
      amount_paid: 31000,
      parent: { subscription_details: { subscription: SUB } },
    });
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.sub().catchupState).toBeNull();
  });

  it("a claim with no stored session id can never be proven: no settlement", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: null }, [
      octOpen,
    ]);
    await h.svc.onInvoicePaid({
      id: "in_x",
      amount_paid: 100,
      parent: { subscription_details: { subscription: SUB } },
    });
    expect(h.inv("inv_oct").status).toBe("OPEN");
  });
});

describe("Opus SHOULD-FIX 2: the settling invoice must carry the amount the session promised (fail closed)", () => {
  const meta = {
    tenantId: "t1",
    catchup: "period",
    catchup_shape: "trial_one_time",
    catchup_stub_cents: "31000",
  };
  const withSession = (amountPaid: number) =>
    make(awaiting({ catchupInvoiceId: "in_ot" }), [octOpen, novOpen], {
      invoices: [
        { id: "in_ot", status: "paid", subscription: SUB, amountDue: amountPaid, amountPaid },
      ],
      sessions: {
        [SESSION]: { id: SESSION, subscription: SUB, status: "complete", metadata: meta },
      },
    });
  const paid = (n: number) => ({
    id: "in_ot",
    amount_paid: n,
    parent: { subscription_details: { subscription: SUB } },
  });

  it("the exact amount settles", async () => {
    const h = withSession(31000);
    await h.svc.onInvoicePaid(paid(31000));
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.sub().catchupState).toBeNull();
  });

  it("a DIFFERENT amount HOLDS the claim: nothing voided, a NEEDS RULING notice ONCE (a second delivery adds none)", async () => {
    const h = withSession(5000);
    await h.svc.onInvoicePaid(paid(5000));
    await h.svc.onInvoicePaid(paid(5000));
    expect(h.inv("inv_oct").status).toBe("OPEN");
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
    const notices = h.db.audits.filter((a) => a.meta?.kind === "billing_catchup_amount_mismatch");
    expect(notices).toHaveLength(1);
    expect(notices[0].meta).toMatchObject({ expectedCents: 31000, gotCents: 5000 });
  });

  it("a $0 draft that finalized without its stub item (the lost-stub case) is HELD, not settled", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_stub" }), [octOpen], {
      invoices: [{ id: "in_stub", status: "paid", subscription: SUB, amountDue: 0, amountPaid: 0 }],
      sessions: {
        [SESSION]: {
          id: SESSION,
          subscription: SUB,
          status: "complete",
          metadata: { ...meta, catchup_shape: "trial", catchup_stub_cents: "17567" },
        },
      },
    });
    await h.svc.onInvoicePaid({
      id: "in_stub",
      amount_paid: 0,
      parent: { subscription_details: { subscription: SUB } },
    });
    expect(h.inv("inv_oct").status).toBe("OPEN");
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });
});

describe("Opus SHOULD-FIX 1: the prepaid stub item survives a redelivery", () => {
  const stubSession = () =>
    sessionOf({
      metadata: {
        tenantId: "t1",
        catchup: "prepaid",
        catchup_shape: "trial",
        catchup_stub_cents: "17567",
        catchup_stub_label: "Subscription — November 2026 (from Nov 14)",
        catchup_finalize_at: String(Math.floor(Date.parse("2026-11-14T12:00:00Z") / 1000)),
      },
    });

  it("invoices.create ok, invoiceItems.create FAILS, the redelivery adds the item to the same draft (same keys)", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [
      octPaid,
    ]);
    h.stripe.client.invoiceItems.create.mockRejectedValueOnce(new Error("stripe 500"));
    await expect(h.svc.onSessionCompleted(stubSession())).rejects.toThrow("stripe 500");
    const draftId = h.sub().catchupInvoiceId;
    expect(draftId).toMatch(/^in_stub/);
    expect(h.stripe.invoices.get(draftId)!.amountDue).toBe(0); // a $0 draft: the stub would be lost

    await h.svc.onSessionCompleted(stubSession()); // the redelivery
    expect(h.stripe.invoices.get(draftId)!.amountDue).toBe(17567);
    expect(h.stripe.client.invoices.create).toHaveBeenCalledTimes(1); // the draft is not re-created
    const itemCalls = h.stripe.client.invoiceItems.create.mock.calls;
    expect(itemCalls[itemCalls.length - 1][1]).toEqual({
      idempotencyKey: `t1:trial-stub-item:${SESSION}`,
    });
  });

  it("a draft that already carries the item gets no second one", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [
      octPaid,
    ]);
    await h.svc.onSessionCompleted(stubSession());
    await h.svc.onSessionCompleted(stubSession());
    expect(h.stripe.client.invoiceItems.create).toHaveBeenCalledTimes(1);
  });
});

describe("(c)/(d) the stub's automatically_finalizes_at is deterministic and never in the past", () => {
  const WEBHOOK_RETRY_S = 3 * 24 * 3600;
  const sess = (finalizeAt: number, expiresAt?: number) =>
    sessionOf({
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      metadata: {
        tenantId: "t1",
        catchup: "prepaid",
        catchup_shape: "trial",
        catchup_stub_cents: "17567",
        catchup_finalize_at: String(finalizeAt),
      },
    });
  const claimOpen = () =>
    make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [octPaid]);
  const finalizeAtOf = (h: ReturnType<typeof make>) =>
    h.stripe.client.invoices.create.mock.calls[0][0].automatically_finalizes_at;
  const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  it("the planned time (12:00Z of the paid-through day) stands when it is after the floor", async () => {
    const h = claimOpen();
    await h.svc.onSessionCompleted(sess(sec("2026-11-14T12:00:00Z"))); // session expires Oct 10
    expect(finalizeAtOf(h)).toBe(sec("2026-11-14T12:00:00Z"));
  });

  it("never earlier than the session's expiry + Stripe's 3-day webhook retry window + 1 h: valid on EVERY retry", async () => {
    const expires = sec("2026-11-14T10:00:00Z");
    const h = claimOpen();
    await h.svc.onSessionCompleted(sess(sec("2026-11-14T12:00:00Z"), expires));
    expect(finalizeAtOf(h)).toBe(expires + WEBHOOK_RETRY_S + 3600);
  });

  it("the SAME session yields the SAME timestamp at any wall-clock time (a retried create must not change its params)", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    try {
      const seen: number[] = [];
      for (const wall of ["2026-10-09T10:00:00Z", "2026-10-10T09:00:00Z", "2030-01-01T00:00:00Z"]) {
        nowSpy.mockReturnValue(Date.parse(wall));
        const h = claimOpen();
        await h.svc.onSessionCompleted(sess(sec("2026-10-12T12:00:00Z")));
        seen.push(finalizeAtOf(h));
      }
      expect(new Set(seen).size).toBe(1);
      expect(seen[0]).toBe(SESSION_EXPIRES_AT + WEBHOOK_RETRY_S + 3600);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("a session with no expiry (hand-built) falls back to now + 1 h, as before", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(Date.parse("2026-11-14T15:00:00Z")); // after that day's 12:00Z
      const h = claimOpen();
      const noExpiry = sess(sec("2026-11-14T12:00:00Z"));
      delete (noExpiry as any).expires_at;
      await h.svc.onSessionCompleted(noExpiry);
      expect(finalizeAtOf(h)).toBe(sec("2026-11-14T16:00:00Z"));
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("Opus SHOULD-FIX 5: a failed payment with no stored invoice id still voids the failed invoice", () => {
  it("adopts invoice.id first, so Step 2 voids it", async () => {
    const h = make(awaiting({ catchupInvoiceId: null }), [octOpen], {
      invoices: [
        {
          id: "in_fail",
          status: "open",
          subscription: SUB,
          amountDue: 31000,
          attemptCount: 4,
          nextPaymentAttempt: null,
        },
      ],
    });
    await h.svc.onPaymentFailed({
      id: "in_fail",
      parent: { subscription_details: { subscription: SUB } },
    });
    expect(h.stripe.calls).toEqual(
      expect.arrayContaining(["voidInvoice:in_fail", `cancelSubscription:${SUB}`]),
    );
    expect(h.stripe.invoices.get("in_fail")!.status).toBe("void");
    expect(h.sub()).toMatchObject({ catchupState: null, stripeSubId: null, externalPayment: true });
  });
});

describe("MF4 (Opus SHOULD-FIX 6, tightened): a completed catch-up session is cleared ONLY once the ordinary handler has decided against it", () => {
  const sessionExpiresAt = Math.floor(Date.parse("2026-10-10T10:00:00Z") / 1000);
  const sessionOf2 = (sub: string) => ({
    id: SESSION,
    subscription: sub,
    status: "complete",
    expires_at: sessionExpiresAt,
    metadata: { tenantId: "t1", catchup: "period" },
  });
  const stuck = (o: { otherLive?: boolean } = {}) =>
    make(
      { stripeSubId: "sub_other", catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octOpen],
      {
        sessions: { [SESSION]: sessionOf2("sub_dup") },
        subs: {
          [SUB]: {
            id: SUB,
            customer: "cus_1",
            latest_invoice: null,
            default_payment_method: "pm_1",
          },
          ...(o.otherLive
            ? { sub_other: { id: "sub_other", status: "active", customer: "cus_1" } }
            : {}),
        },
      },
    );
  const decide = (h: ReturnType<typeof make>, action: string) =>
    h.db.audits.push({
      tenantId: null,
      action,
      entityType: "stripe_checkout_session",
      entityId: SESSION,
      meta: {},
    });
  const lateAlerts = (h: ReturnType<typeof make>) =>
    h.db.audits.filter((a) => a.meta?.kind === "billing_catchup_late_completion");

  it("no decision on record and no different LIVE subscription stored: HELD at expires_at + 2 h (Stripe retries for 3 days)", async () => {
    const h = stuck();
    await h.svc.sweep(new Date("2026-10-10T11:00:00Z"));
    await h.svc.sweep(new Date("2026-10-10T13:00:00Z"));
    expect(h.sub()).toMatchObject({ catchupState: "SESSION_OPEN", catchupSessionId: SESSION });
    expect(
      h.db.audits.filter((a) => a.meta?.kind === "billing_catchup_stuck_completed"),
    ).toHaveLength(0);
    expect(lateAlerts(h)).toHaveLength(0);
  });

  it.each(["STRIPE_CHECKOUT_DUPLICATE", "STRIPE_CHECKOUT_REFUSED"])(
    "the ordinary handler's %s record for that session: NEEDS RULING (once) and the claim is cleared; RfInvoices untouched",
    async (action) => {
      const h = stuck();
      decide(h, action);
      await h.svc.sweep(new Date("2026-10-10T13:00:00Z"));
      await h.svc.sweep(new Date("2026-10-10T14:00:00Z"));
      expect(h.sub()).toMatchObject({ catchupState: null, catchupSessionId: null });
      expect(h.sub().stripeSubId).toBe("sub_other"); // the stored subscription is not touched
      expect(h.inv("inv_oct").status).toBe("OPEN");
      const notices = h.db.audits.filter((a) => a.meta?.kind === "billing_catchup_stuck_completed");
      expect(notices).toHaveLength(1);
      expect(notices[0].meta).toMatchObject({ subscriptionId: "sub_dup" });
    },
  );

  it("a DIFFERENT live subscription stored (not the session's): cleared with the NEEDS RULING alert", async () => {
    const h = stuck({ otherLive: true });
    await h.svc.sweep(new Date("2026-10-10T13:00:00Z"));
    expect(h.sub()).toMatchObject({ catchupState: null, catchupSessionId: null });
    expect(
      h.db.audits.filter((a) => a.meta?.kind === "billing_catchup_stuck_completed"),
    ).toHaveLength(1);
  });

  it("a completed session whose sub IS the stored one is not 'stuck' (it advances instead)", async () => {
    const h = make(
      { stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octOpen],
      { sessions: { [SESSION]: sessionOf2(SUB) } },
    );
    await h.svc.sweep(new Date("2026-10-11T00:00:00Z"));
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });

  it("CATCHUP_LATE_ALERT_DAYS = 3: still undecided after that long, ONE structured operator alert (never a tenant email), the claim stays held", async () => {
    expect(CATCHUP_LATE_ALERT_DAYS).toBe(3);
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const h = stuck();
      const justBefore = new Date((sessionExpiresAt + 3 * 24 * 3600 - 3600) * 1000);
      await h.svc.sweep(justBefore);
      expect(lateAlerts(h)).toHaveLength(0);

      const late = new Date((sessionExpiresAt + 3 * 24 * 3600 + 3600) * 1000);
      await h.svc.sweep(late);
      await h.svc.sweep(new Date(late.getTime() + 3600_000)); // the hourly sweep must not re-raise it
      expect(lateAlerts(h)).toHaveLength(1);
      expect(lateAlerts(h)[0].meta).toMatchObject({
        sessionId: SESSION,
        subscriptionId: "sub_dup",
        dedupeKey: SESSION,
      });
      const logged = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("billing.catchup.late_completion"));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0].slice(logged[0].indexOf("{")))).toMatchObject({
        tenantId: "t1",
        sessionId: SESSION,
        subscriptionId: "sub_dup",
        days: CATCHUP_LATE_ALERT_DAYS,
      });
      // held, not cleared; nothing was emitted (the events bus is the only outbound channel the service has)
      expect(h.sub()).toMatchObject({ catchupState: "SESSION_OPEN", catchupSessionId: SESSION });
      expect(h.events.emit).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("the claim service has no email / notification dependency at all (dark is silent)", () => {
    const src = fs.readFileSync(path.join(__dirname, "catchup-claim.service.ts"), "utf8");
    expect(src).not.toMatch(/from "[^"]*(email|mail|notification)[^"]*"/i);
    expect(CatchupClaimService.length).toBe(3); // prisma, stripe, events: no mailer in the constructor
  });
});

describe("(b) sweepAwaiting has an exit when the subscription was cancelled at Stripe", () => {
  const cancelledSub = (status = "canceled") => ({
    [SUB]: { id: SUB, customer: "cus_1", latest_invoice: null, status },
  });
  const openInvoice = {
    id: "in_1",
    status: "open" as const,
    subscription: SUB,
    amountDue: 31000,
    attemptCount: 1,
    nextPaymentAttempt: 1791172800, // another attempt is scheduled: NOT definitively failed
  };

  it("cancelled at Stripe, nothing paid, the invoice still open: released - manual invoicing resumes, the invoice is voided (no claim frozen forever)", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_1" }), [octOpen], {
      invoices: [openInvoice],
      subs: cancelledSub(),
    });
    await h.svc.sweep(NOW);
    expect(h.sub()).toMatchObject({
      catchupState: null,
      catchupSessionId: null,
      stripeSubId: null,
      externalPayment: true,
    });
    expect(h.stripe.invoices.get("in_1")!.status).toBe("void");
    expect(h.inv("inv_oct").status).toBe("OPEN"); // RouteFlow invoicing carries on
  });

  it("cancelled at Stripe before any invoice with money was stored: released too", async () => {
    const h = make(awaiting({ catchupInvoiceId: null }), [octOpen], { subs: cancelledSub() });
    await h.svc.sweep(NOW);
    expect(h.sub()).toMatchObject({ catchupState: null, stripeSubId: null, externalPayment: true });
  });

  it("a subscription Stripe no longer knows (resource_missing) counts as gone", async () => {
    const h = make(awaiting({ catchupInvoiceId: null }), [octOpen], { subs: {} });
    await h.svc.sweep(NOW);
    expect(h.sub()).toMatchObject({ catchupState: null, stripeSubId: null });
  });

  it("a PAID settling invoice wins over a cancelled subscription: it settles, it is not released", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_1" }), [octOpen], {
      invoices: [
        { id: "in_1", status: "paid", subscription: SUB, amountDue: 31000, amountPaid: 31000 },
      ],
      subs: cancelledSub(),
    });
    await h.svc.sweep(NOW);
    expect(h.inv("inv_oct").status).toBe("VOID");
    expect(h.sub()).toMatchObject({ catchupState: null, externalPayment: false });
    expect(h.stripe.calls.some((c) => c.startsWith("cancelSubscription"))).toBe(false);
  });

  it("a live subscription with an open invoice still being retried is left alone", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_1" }), [octOpen], {
      invoices: [openInvoice],
      subs: cancelledSub("active"),
    });
    await h.svc.sweep(NOW);
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
    expect(h.stripe.calls.some((c) => c.startsWith("cancelSubscription"))).toBe(false);
  });

  it("a payment still PROCESSING (ACH) defers the release even on a cancelled subscription", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_1" }), [octOpen], {
      invoices: [{ ...openInvoice, processing: true }],
      subs: cancelledSub(),
    });
    await h.svc.sweep(NOW);
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT");
  });
});

describe("(a) a released catch-up restores the MANUAL period so its window is not skipped", () => {
  const OCT1 = new Date("2026-10-01T12:00:00Z");
  const NOV1 = new Date("2026-11-01T12:00:00Z");
  const manual = { periodStart: OCT1, periodEnd: NOV1 };
  const periodRecords = (h: ReturnType<typeof make>) =>
    h.db.audits.filter((a) => a.meta?.kind === "billing_catchup_manual_period");

  it("openClaim records the manual period it found, inside the claim's own transaction", async () => {
    const h = make({ ...manual });
    await h.svc.openClaim("t1");
    expect(periodRecords(h)).toHaveLength(1);
    expect(periodRecords(h)[0].meta).toMatchObject({
      periodStart: OCT1.toISOString(),
      periodEnd: NOV1.toISOString(),
    });
  });

  it("the checkout's completion moves the period to Stripe's trial window; the RELEASE puts the manual one back", async () => {
    const h = make({ ...manual }, [octOpen], {
      invoices: [
        {
          id: "in_1",
          status: "open",
          subscription: SUB,
          amountDue: 31000,
          attemptCount: 4,
          nextPaymentAttempt: null, // definitively failed
        },
      ],
    });
    await h.svc.openClaim("t1");
    await h.svc.attachSession("t1", SESSION);
    // what the ordinary completion wrote: the card subscription, its trialing window, manual invoicing off
    Object.assign(h.sub(), {
      stripeSubId: SUB,
      externalPayment: false,
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupInvoiceId: "in_1",
      periodStart: new Date("2026-10-09T12:00:00Z"),
      periodEnd: new Date("2026-12-01T12:00:00Z"),
    });
    await h.svc.sweep(NOW);
    expect(h.sub()).toMatchObject({
      catchupState: null,
      stripeSubId: null,
      externalPayment: true,
      periodStart: OCT1,
      periodEnd: NOV1,
    });
  });

  it("the LATEST recorded period wins (an older record from an earlier, released claim is ignored)", async () => {
    const h = make({ ...manual }, [octOpen], {
      invoices: [
        { id: "in_1", status: "open", subscription: SUB, amountDue: 100, attemptCount: 4 },
      ],
    });
    h.db.audits.push({
      tenantId: "t1",
      action: "TENANT_CONFIG_UPDATED",
      entityType: "platform_admin",
      entityId: "t1",
      meta: {
        kind: "billing_catchup_manual_period",
        periodStart: "2026-09-01T12:00:00.000Z",
        periodEnd: "2026-10-01T12:00:00.000Z",
      },
    });
    await h.svc.openClaim("t1");
    expect(periodRecords(h)).toHaveLength(2);
    Object.assign(h.sub(), {
      stripeSubId: SUB,
      externalPayment: false,
      catchupState: "AWAITING_FIRST_PAYMENT",
      catchupSessionId: SESSION,
      catchupInvoiceId: "in_1",
      periodStart: new Date("2026-10-09T12:00:00Z"),
      periodEnd: new Date("2026-12-01T12:00:00Z"),
    });
    await h.svc.sweep(NOW);
    expect(h.sub()).toMatchObject({ periodStart: OCT1, periodEnd: NOV1 });
  });

  it("no record (a claim opened before this fix) restores nothing and does not fail the release", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_1", ...manual }), [octOpen], {
      invoices: [
        { id: "in_1", status: "open", subscription: SUB, amountDue: 100, attemptCount: 4 },
      ],
    });
    Object.assign(h.sub(), { periodEnd: new Date("2026-12-01T12:00:00Z") });
    await h.svc.release("t1", { sessionId: SESSION, reason: "t" });
    expect(h.sub()).toMatchObject({ catchupState: null, stripeSubId: null, externalPayment: true });
    expect(h.sub().periodEnd).toEqual(new Date("2026-12-01T12:00:00Z"));
  });

  it("a PAID settlement keeps Stripe's period (nothing is restored on the success path)", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_1", ...manual }), [octOpen], {
      invoices: [
        { id: "in_1", status: "paid", subscription: SUB, amountDue: 31000, amountPaid: 31000 },
      ],
    });
    await h.svc.openClaim("t1").catch(() => undefined); // already claimed: refused, records nothing
    Object.assign(h.sub(), { periodEnd: new Date("2026-12-01T12:00:00Z") });
    await h.svc.sweep(NOW);
    expect(h.sub()).toMatchObject({ catchupState: null, externalPayment: false });
    expect(h.sub().periodEnd).toEqual(new Date("2026-12-01T12:00:00Z"));
  });

  it("releasing a SESSION_OPEN claim never touches the period (the session never completed)", async () => {
    const h = make({ ...manual });
    await h.svc.openClaim("t1");
    await h.svc.attachSession("t1", SESSION);
    h.stripe.sessions[SESSION] = { id: SESSION, status: "expired", metadata: { tenantId: "t1" } };
    await h.svc.sweep(NOW);
    expect(h.sub()).toMatchObject({ catchupState: null, periodStart: OCT1, periodEnd: NOV1 });
  });
});

describe("nits", () => {
  it("the release's refused-because-paid NEEDS RULING is raised ONCE per invoice, not on every hourly retry", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_1" }), [octOpen], {
      invoices: [
        { id: "in_1", status: "open", subscription: SUB, amountDue: 100, attemptCount: 3 },
      ],
    });
    h.stripe.voidInvoice.mockImplementation(async (id: string) => {
      h.stripe.invoices.get(id)!.status = "paid";
      throw new Error("paid");
    });
    await h.svc.release("t1", { sessionId: SESSION, reason: "t" });
    await h.svc.sweep(NOW); // the RELEASING row is retried
    await h.svc.sweep(NOW);
    expect(
      h.db.audits.filter((a) => a.meta?.kind === "billing_catchup_release_refused_paid"),
    ).toHaveLength(1);
  });

  it("sweepAwaiting adopts the OLDEST invoice with money (Stripe lists newest first)", async () => {
    const h = make(awaiting({ catchupInvoiceId: null }), [octOpen], {
      // Stripe order: newest first
      invoices: [
        {
          id: "in_renewal",
          status: "open",
          subscription: SUB,
          amountDue: 31000,
          attemptCount: 1,
          nextPaymentAttempt: 1791172800,
        },
        { id: "in_first", status: "paid", subscription: SUB, amountDue: 31000, amountPaid: 31000 },
      ],
    });
    await h.svc.sweep(NOW);
    expect(h.inv("inv_oct").status).toBe("VOID"); // settled by in_first, not judged by the newer open renewal
    expect(h.sub().catchupState).toBeNull();
  });
});

describe("Lead delta review", () => {
  const stubMeta = {
    tenantId: "t1",
    catchup: "prepaid",
    catchup_shape: "trial",
    catchup_stub_cents: "17567",
    catchup_stub_label: "Subscription — November 2026 (from Nov 14)",
    catchup_finalize_at: String(Math.floor(Date.parse("2026-11-14T12:00:00Z") / 1000)),
  };

  it("(1) DOUBLE-CHARGE: the stub item is tagged catchup_for=<session>; a Stripe-side coupon that lowers amountDue never makes a redelivery add a SECOND stub", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [
      octPaid,
    ]);
    await h.svc.onSessionCompleted(sessionOf({ metadata: stubMeta }));
    const draftId = h.sub().catchupInvoiceId;
    const first = h.stripe.client.invoiceItems.create.mock.calls[0][0];
    expect(first.metadata).toEqual({ catchup_for: SESSION, tenantId: "t1" });

    // a coupon / discount on the customer lowers what the draft will charge, far below the stub
    h.stripe.invoices.get(draftId)!.amountDue = 5000;
    // the redelivery arrives after the 24 h idempotency window: Stripe would NOT replay the first create
    await h.svc.onSessionCompleted(sessionOf({ metadata: stubMeta }));
    await h.svc.onSessionCompleted(sessionOf({ metadata: stubMeta }));

    expect(h.stripe.client.invoiceItems.create).toHaveBeenCalledTimes(1);
  });

  it("(1) an item tagged for ANOTHER session does not count as this session's stub", async () => {
    const h = make({ stripeSubId: SUB, catchupState: "SESSION_OPEN", catchupSessionId: SESSION }, [
      octPaid,
    ]);
    h.stripe.client.invoiceItems.create.mockRejectedValueOnce(new Error("stripe 500"));
    await expect(h.svc.onSessionCompleted(sessionOf({ metadata: stubMeta }))).rejects.toThrow();
    const draftId = h.sub().catchupInvoiceId;
    await h.stripe.client.invoiceItems.create({
      invoice: draftId,
      amount: 100,
      metadata: { catchup_for: "cs_other" },
    });
    h.stripe.client.invoiceItems.create.mockClear();
    await h.svc.onSessionCompleted(sessionOf({ metadata: stubMeta }));
    expect(h.stripe.client.invoiceItems.create).toHaveBeenCalledTimes(1);
    expect(h.stripe.client.invoiceItems.create.mock.calls[0][0].metadata.catchup_for).toBe(SESSION);
  });

  it("(2) release Step 0: a HELD settle (amount mismatch) is reported needs_ruling, never 'settled'", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_ot" }), [octOpen], {
      invoices: [
        { id: "in_ot", status: "paid", subscription: SUB, amountDue: 5000, amountPaid: 5000 },
      ],
      sessions: {
        [SESSION]: {
          id: SESSION,
          subscription: SUB,
          status: "complete",
          metadata: {
            tenantId: "t1",
            catchup: "period",
            catchup_shape: "trial_one_time",
            catchup_stub_cents: "31000",
          },
        },
      },
    });
    const out = await h.svc.release("t1", { sessionId: SESSION, reason: "t" });
    expect(out).toBe("needs_ruling");
    expect(h.sub().catchupState).toBe("AWAITING_FIRST_PAYMENT"); // still HELD
    expect(h.inv("inv_oct").status).toBe("OPEN");
    expect(h.stripe.cancelSubscription).not.toHaveBeenCalled();
  });

  it("(2) a settle that DID succeed is still 'settled'", async () => {
    const h = make(awaiting({ catchupInvoiceId: "in_ok" }), [octOpen], {
      invoices: [
        { id: "in_ok", status: "paid", subscription: SUB, amountDue: 100, amountPaid: 100 },
      ],
    });
    expect(await h.svc.release("t1", { sessionId: SESSION, reason: "t" })).toBe("settled");
  });

  it("(2) the module header carries the operator runbook line for a HELD claim", () => {
    const src = fs.readFileSync(path.join(__dirname, "catchup-claim.service.ts"), "utf8");
    expect(src).toMatch(/OPERATOR RUNBOOK - leaving a HELD claim/);
    expect(src).toMatch(/UPDATE "TenantSubscription" SET "catchupState"=NULL/);
  });

  it("(3) the stuck-completed notice names the STORED subscription too (an ordinary one that also bills)", async () => {
    const exp = Math.floor(Date.parse("2026-10-10T10:00:00Z") / 1000);
    const h = make(
      { stripeSubId: "sub_ordinary", catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octOpen],
      {
        sessions: {
          [SESSION]: {
            id: SESSION,
            subscription: "sub_dup",
            status: "complete",
            expires_at: exp,
            metadata: { tenantId: "t1", catchup: "period" },
          },
        },
        // MF4: a DIFFERENT LIVE subscription stored is what makes the stuck claim clearable
        subs: {
          [SUB]: { id: SUB, customer: "cus_1", latest_invoice: null },
          sub_ordinary: { id: "sub_ordinary", status: "active", customer: "cus_1" },
        },
      },
    );
    await h.svc.sweep(new Date("2026-10-10T13:00:00Z"));
    const n = h.db.audits.find((a) => a.meta?.kind === "billing_catchup_stuck_completed")!;
    expect(n.meta).toMatchObject({
      subscriptionId: "sub_dup",
      storedSubscriptionId: "sub_ordinary",
    });
    expect(n.meta.message).toContain("sub_ordinary");
  });

  it("optional: a FOREIGN paid invoice on a claimed tenant raises ONE NEEDS RULING notice per invoice (and still voids nothing)", async () => {
    const h = make(
      { stripeSubId: "sub_ord", catchupState: "SESSION_OPEN", catchupSessionId: SESSION },
      [octOpen],
    );
    const inv = {
      id: "in_ord",
      amount_paid: 100,
      parent: { subscription_details: { subscription: "sub_ord" } },
    };
    await h.svc.onInvoicePaid(inv);
    await h.svc.onInvoicePaid(inv);
    expect(
      h.db.audits.filter((a) => a.meta?.kind === "billing_catchup_foreign_invoice"),
    ).toHaveLength(1);
    expect(h.inv("inv_oct").status).toBe("OPEN");
  });
});
