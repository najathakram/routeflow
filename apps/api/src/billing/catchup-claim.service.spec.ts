import { CatchupClaimService } from "./catchup-claim.service";
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

const sessionOf = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  customer: "cus_1",
  subscription: SUB,
  payment_status: "unpaid",
  metadata: { tenantId: "t1", catchup: "2026-10", ...(over.metadata as object) },
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
  });
  const svc = new CatchupClaimService(db.prisma, stripe as any);
  return {
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
      response: { code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE },
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
      return { id: "ii_1", invoice: params.invoice };
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
      return {};
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
          metadata: { tenantId: "t1", catchup: "2026-10" },
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
          metadata: { tenantId: "t1", catchup: "2026-10" },
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
            metadata: { tenantId: "t1", catchup: "2026-10" },
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
    });
    const svc = new CatchupClaimService(db.prisma, stripe as any);
    stripe.getInvoiceFacts.mockImplementationOnce(async () => {
      throw new Error("stripe 500");
    });
    const out = await svc.sweep(NOW);
    expect(out.errors).toBe(1);
    expect(db.invoices.find((i) => i.id === "ib")!.status).toBe("VOID");
  });
});
