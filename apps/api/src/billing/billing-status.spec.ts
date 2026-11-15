import type { BillingStatusAction, BillingStatusState, BillingStatusView } from "@routeflow/types";
import { TRIAL_NOTICE_DAYS as SHARED_TRIAL_NOTICE_DAYS } from "@routeflow/types";
import {
  BILLING_STATUS_STATES,
  billingStatusOf,
  hasStaleDunningMarker,
  hasTwoPaySources,
  TRIAL_NOTICE_DAYS,
  type BillingStatusInput,
} from "./billing-status";

/** SA-1146 B-5: every state of the section 1 table, and the role rule, each case red on the WRONG value. */

describe("TRIAL_NOTICE_DAYS pin", () => {
  it("the local copy equals the shared constant", () => {
    expect(TRIAL_NOTICE_DAYS).toBe(SHARED_TRIAL_NOTICE_DAYS);
  });
});

const NOW = new Date("2026-11-15T12:00:00.000Z");
const ZONE = "America/Chicago";
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY_MS).toISOString();
const chicagoDay = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));

const CARD = { brand: "Visa", last4: "4242", expMonth: 12, expYear: 2030 };
const NO_DUE = {
  due: false,
  pastDue: false,
  amountCents: 0,
  periodLabel: null,
  periodStart: null,
  cardNeeded: false,
  chargeStartsOn: null,
  cardBy: null,
};

function input(
  sub: Partial<BillingStatusInput["subscription"]> = {},
  due: Partial<BillingStatusInput["paymentDue"]> = {},
  isAdmin = true,
): BillingStatusInput {
  return {
    subscription: {
      status: "ACTIVE",
      trialEndsAt: null,
      readOnlyReason: null,
      pastDueInvoiceId: null,
      pastDueSince: null,
      paymentMethodSummary: CARD,
      nextCharge: null,
      billingState: "current",
      ...sub,
    },
    paymentDue: { ...NO_DUE, ...due },
    now: NOW,
    timeZone: ZONE,
    isAdmin,
  };
}

const PAY_INVOICE = { kind: "pay", target: "hosted_invoice" } as const;
const PICK_PLAN = { kind: "choose_plan", target: "choose_plan" } as const;
const IN_DUNNING = {
  billingState: "overdue" as const,
  pastDueInvoiceId: "in_1",
  pastDueSince: "2026-11-10T20:00:00.000Z",
  outstandingTotal: 59.5,
};

interface Row {
  name: string;
  input: BillingStatusInput;
  want: BillingStatusView;
  /** SA-1150 1a: true only for the catch-up bill, the one amount staff see today. */
  staffAmount?: boolean;
}

const ROWS: Row[] = [
  {
    name: "paid up: next payment is the tenant-local day, not the UTC day",
    // 03:00Z on Dec 1 is still Nov 30 in Chicago
    input: input({ nextCharge: { amount: 49.5, date: "2026-12-01T03:00:00.000Z" } }),
    want: { state: "paid_up", amount: 49.5, dueOn: "2026-11-30", action: null },
  },
  {
    name: "due (Stripe invoice, not past due): Pay $X to the hosted invoice",
    input: input({ billingState: "due", outstandingTotal: 298 }),
    want: { state: "due", amount: 298, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "due (overdue invoice, no dunning yet): still Pay $X to the hosted invoice",
    input: input({ billingState: "overdue", outstandingTotal: 75 }),
    want: { state: "due", amount: 75, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "due (catch-up, invoiced by hand): Pay $X to the catch-up Checkout, on the period day",
    input: input(
      { billingState: undefined },
      { due: true, amountCents: 4999, periodStart: "2026-11-01T05:00:00.000Z" },
    ),
    want: {
      state: "due",
      amount: 49.99,
      dueOn: "2026-11-01",
      action: { kind: "pay", target: "checkout" },
    },
    staffAmount: true,
  },
  {
    name: "due (both sources present): the Stripe invoice wins, the one Stripe will charge",
    input: input(
      { billingState: "due", outstandingTotal: 120 },
      { due: true, amountCents: 4999, periodStart: "2026-11-01T05:00:00.000Z" },
    ),
    want: { state: "due", amount: 120, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "due (card needed, no card on file, nothing charged now): Add card to the checkout, by the card deadline",
    input: input(
      { billingState: undefined, paymentMethodSummary: null },
      {
        cardNeeded: true,
        cardBy: "2026-11-20T03:00:00.000Z",
        chargeStartsOn: "2026-11-23T03:00:00.000Z",
      },
    ),
    want: {
      state: "due",
      amount: null,
      dueOn: "2026-11-19",
      action: { kind: "add_card", target: "checkout" },
    },
  },
  {
    name: "failed: Pay $X to the hosted invoice (master sent the strip to the portal); deadline = first failure + 14 days in the tenant zone",
    input: input(IN_DUNNING),
    want: { state: "failed", amount: 59.5, dueOn: "2026-11-24", action: PAY_INVOICE },
  },
  {
    name: "failed beats a card-needed catch-up: the invoice is what unlocks",
    input: input(IN_DUNNING, { cardNeeded: true, cardBy: "2026-11-20T03:00:00.000Z" }),
    want: { state: "failed", amount: 59.5, dueOn: "2026-11-24", action: PAY_INVOICE },
  },
  {
    name: "read-only for an unpaid amount: Pay $X to the hosted invoice",
    input: input({ ...IN_DUNNING, status: "READ_ONLY", readOnlyReason: "payment_overdue" }),
    want: { state: "read_only", amount: 59.5, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "read-only, unpaid amount but no recorded reason: still read-only with Pay",
    input: input({ status: "READ_ONLY", billingState: "overdue", outstandingTotal: 12 }),
    want: { state: "read_only", amount: 12, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "processing (a bank debit settling): the amount, no action",
    input: input({ billingState: "processing", paymentProcessing: true, outstandingTotal: 80 }),
    want: { state: "processing", amount: 80, dueOn: null, action: null },
  },
  {
    name: "processing beats failed: a settling debit is never shown as failed (B1256)",
    input: input({ ...IN_DUNNING, billingState: "processing", outstandingTotal: 80 }),
    want: { state: "processing", amount: 80, dueOn: null, action: null },
  },
  {
    name: "trial ending within the notice window: Choose a plan, on the tenant-local end day",
    // 03:00Z, 3 days out, is the previous evening in Chicago
    input: input({
      status: "TRIAL",
      trialEndsAt: "2026-11-18T03:00:00.000Z",
      billingState: undefined,
    }),
    want: { state: "trial", amount: null, dueOn: "2026-11-17", action: PICK_PLAN },
  },
  {
    name: "trial: exactly TRIAL_NOTICE_DAYS out is inside the window",
    input: input({
      status: "TRIAL",
      trialEndsAt: inDays(TRIAL_NOTICE_DAYS),
      billingState: undefined,
    }),
    want: {
      state: "trial",
      amount: null,
      dueOn: chicagoDay(inDays(TRIAL_NOTICE_DAYS)),
      action: PICK_PLAN,
    },
  },
  {
    name: "trial: one day past the notice window says nothing",
    input: input({
      status: "TRIAL",
      trialEndsAt: inDays(TRIAL_NOTICE_DAYS + 1),
      billingState: undefined,
    }),
    want: { state: "none", amount: null, dueOn: null, action: null },
  },
  {
    name: "trial ended (status TRIAL, end instant passed): Choose a plan",
    input: input({ status: "TRIAL", trialEndsAt: inDays(-1), billingState: undefined }),
    want: { state: "trial_ended", amount: null, dueOn: null, action: PICK_PLAN },
  },
  {
    name: "trial ended (locked read-only, reason trial_expired): Choose a plan, never Pay",
    input: input({
      status: "READ_ONLY",
      readOnlyReason: "trial_expired",
      trialEndsAt: inDays(-3),
      billingState: undefined,
    }),
    want: { state: "trial_ended", amount: null, dueOn: null, action: PICK_PLAN },
  },
  {
    name: "none: Stripe could not answer (billingState omitted), so never paid up",
    input: input({ billingState: undefined }),
    want: { state: "none", amount: null, dueOn: null, action: null },
  },
  {
    name: "none: active, owes nothing, but no automatic payment on",
    input: input({ paymentMethodSummary: null }),
    want: { state: "none", amount: null, dueOn: null, action: null },
  },
  {
    name: "none: read-only for a cancelled subscription, nothing owed",
    input: input({ status: "READ_ONLY", readOnlyReason: "subscription_cancelled" }),
    want: { state: "none", amount: null, dueOn: null, action: null },
  },
  {
    name: "amount is rounded with roundMoney (0.1 + 0.2 is 0.3, not 0.30000000000000004)",
    input: input({ billingState: "due", outstandingTotal: 0.1 + 0.2 }),
    want: { state: "due", amount: 0.3, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "amount falls back to the pay-now figure, then the open invoice amount",
    input: input({ billingState: "due", payNowAmount: 41.255, openInvoiceAmount: 99 }),
    want: { state: "due", amount: 41.26, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "MUST 2: two invoices owed (150) but the hosted invoice collects the one payable (50): Pay $50",
    input: input({ billingState: "due", outstandingTotal: 150, payNowAmount: 50 }),
    want: { state: "due", amount: 50, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "MUST 2: the same one-invoice figure in failed",
    input: input({ ...IN_DUNNING, outstandingTotal: 150, payNowAmount: 50 }),
    want: { state: "failed", amount: 50, dueOn: "2026-11-24", action: PAY_INVOICE },
  },
  {
    name: "MUST 2: the same one-invoice figure in read_only",
    input: input({
      ...IN_DUNNING,
      status: "READ_ONLY",
      readOnlyReason: "payment_overdue",
      outstandingTotal: 150,
      payNowAmount: 50,
    }),
    want: { state: "read_only", amount: 50, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "MUST 2: payNowAmount 0 is not a figure: falls back to what is owed, never Pay $0",
    input: input({ billingState: "due", outstandingTotal: 150, payNowAmount: 0 }),
    want: { state: "due", amount: 150, dueOn: null, action: PAY_INVOICE },
  },
  {
    // RULED CHANGE of expectation (lead, SA-1150 S8): round 1 pinned action PAY_INVOICE here; a Pay state with no
    // positive figure has NO Pay action. The amount rule (null, never $0) is unchanged.
    name: "S8: failed with nothing positive anywhere: amount null and NO Pay action (the state stays)",
    input: input({ ...IN_DUNNING, outstandingTotal: 0, payNowAmount: 0, openInvoiceAmount: 0 }),
    want: { state: "failed", amount: null, dueOn: "2026-11-24", action: null },
  },
  {
    name: "S8: Stripe due with no positive figure: state stays, amount null, no Pay action",
    input: input({ billingState: "due", outstandingTotal: 0, payNowAmount: 0 }),
    want: { state: "due", amount: null, dueOn: null, action: null },
  },
  {
    name: "S8: read_only with no figure at all: state stays, amount null, no Pay action",
    input: input({
      status: "READ_ONLY",
      readOnlyReason: "payment_overdue",
      billingState: undefined,
    }),
    want: { state: "read_only", amount: null, dueOn: null, action: null },
  },
  {
    name: "S8: a catch-up bill of 0 cents is not a Pay state either (no Pay to the checkout)",
    input: input({ billingState: undefined }, { due: true, amountCents: 0 }),
    want: { state: "due", amount: null, dueOn: null, action: null },
  },
  {
    name: "S8 does not touch add_card: it is not a Pay state, amount null by rule (S6), the action stays",
    input: input(
      { billingState: undefined, paymentMethodSummary: null },
      { cardNeeded: true, cardBy: "2026-11-20T03:00:00.000Z" },
    ),
    want: {
      state: "due",
      amount: null,
      dueOn: "2026-11-19",
      action: { kind: "add_card", target: "checkout" },
    },
  },
  {
    name: "MUST 2: a pay-now figure that rounds to 0 is treated as 0",
    input: input({ billingState: "due", outstandingTotal: 20, payNowAmount: 0.004 }),
    want: { state: "due", amount: 20, dueOn: null, action: PAY_INVOICE },
  },
  {
    name: "processing has no button: it shows everything settling (outstandingTotal), not one invoice",
    input: input({ billingState: "processing", outstandingTotal: 150, payNowAmount: 50 }),
    want: { state: "processing", amount: 150, dueOn: null, action: null },
  },
  {
    name: "S9: Stripe due, invoice due 2026-11-20 05:00Z: dueOn is the tenant-local day (11-19)",
    input: input({
      billingState: "due",
      outstandingTotal: 149,
      payNowAmount: 149,
      openInvoiceDueAt: "2026-11-20T05:00:00.000Z",
    }),
    want: { state: "due", amount: 149, dueOn: "2026-11-19", action: PAY_INVOICE },
  },
  {
    name: "S12: active, current, a card on file, but no next charge (no subscription, or a $0 next invoice): none",
    input: input({ nextCharge: null }),
    want: { state: "none", amount: null, dueOn: null, action: null },
  },
  {
    name: "S11: dunning marker lags while Stripe already says current: none, never failed with $0, never paid_up",
    input: input({
      billingState: "current",
      pastDueInvoiceId: "in_1",
      pastDueSince: "2026-11-10T20:00:00.000Z",
      nextCharge: { amount: 49.5, date: "2026-12-01T03:00:00.000Z" },
    }),
    want: { state: "none", amount: null, dueOn: null, action: null },
  },
  {
    // 23:30 Chicago on Nov 22 is 05:30Z Nov 23: seven tenant calendar days after Nov 15 (06:00 Chicago), though
    // more than 7 x 24 h away. Master counted milliseconds and said none.
    name: "S13: trial ends 7 tenant-local days ahead at 23:30 local: trial (calendar days, not 24 h blocks)",
    input: input({
      status: "TRIAL",
      trialEndsAt: "2026-11-23T05:30:00.000Z",
      billingState: undefined,
    }),
    want: { state: "trial", amount: null, dueOn: "2026-11-22", action: PICK_PLAN },
  },
  {
    name: "S13: trial ends 8 tenant-local days ahead at 23:30 local: none",
    input: input({
      status: "TRIAL",
      trialEndsAt: "2026-11-24T05:30:00.000Z",
      billingState: undefined,
    }),
    want: { state: "none", amount: null, dueOn: null, action: null },
  },
  {
    name: "S10: locked, no reason, dunning marker, Stripe unreachable: read_only, amount null, no action (was failed)",
    input: input({
      status: "READ_ONLY",
      readOnlyReason: null,
      billingState: undefined,
      pastDueInvoiceId: "in_1",
      pastDueSince: "2026-11-10T20:00:00.000Z",
    }),
    want: { state: "read_only", amount: null, dueOn: null, action: null },
  },
];

describe("billingStatusOf: SA-1146 state table (admin)", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))("%s", (_n, row) => {
    expect(billingStatusOf(row.input)).toEqual(row.want);
  });

  it("covers every member of the union (a new state fails here until it has a row)", () => {
    const covered = new Set<BillingStatusState>(ROWS.map((r) => r.want.state));
    const all = [
      "paid_up",
      "due",
      "failed",
      "read_only",
      "processing",
      "trial",
      "trial_ended",
      "none",
    ];
    expect([...covered].sort()).toEqual([...all].sort());
    expect([...BILLING_STATUS_STATES].sort()).toEqual([...all].sort());
  });
});

describe("BillingStatusAction: the kind union is exactly the SA-1146 B-5 shape", () => {
  // Type-level: a later kind makes the `never` assignment fail to compile here, not in the web's switch.
  const label = (a: BillingStatusAction): string => {
    switch (a.kind) {
      case "pay":
        return "Pay";
      case "add_card":
        return "Add card";
      case "change_card":
        return "Change card";
      case "choose_plan":
        return "Choose a plan";
      default: {
        const unreachable: never = a;
        return String(unreachable);
      }
    }
  };

  it("names the four kinds in the words C7 uses", () => {
    const actions: BillingStatusAction[] = [
      { kind: "pay", target: "hosted_invoice" },
      { kind: "add_card", target: "checkout" },
      { kind: "change_card", target: "portal" },
      { kind: "choose_plan", target: "choose_plan" },
    ];
    expect(actions.map(label)).toEqual(["Pay", "Add card", "Change card", "Choose a plan"]);
  });

  it("S15: the pair is discriminated (a nonsense pair does not compile)", () => {
    // @ts-expect-error add_card goes only to the checkout
    const bad: BillingStatusAction = { kind: "add_card", target: "portal" };
    // @ts-expect-error choose_plan has one target
    const bad2: BillingStatusAction = { kind: "choose_plan", target: "hosted_invoice" };
    expect([bad.kind, bad2.kind]).toEqual(["add_card", "choose_plan"]);
  });

  it("a business with no card gets add_card; no state of the table hands out change_card", () => {
    const kinds = new Set(ROWS.map((r) => billingStatusOf(r.input).action?.kind));
    expect(kinds.has("add_card")).toBe(true);
    expect(kinds.has("change_card")).toBe(false);
  });
});

describe("billingStatusOf: the role rule (staff see the sentence, never a button)", () => {
  // SA-1150 1a: staff see exactly the money they see today: the catch-up bill (amount kept), never a Stripe figure,
  // and never the next-charge day on paid_up (the SA-777 trim hides it). Every other day is a label staff already see.
  const staffWant = (row: Row): BillingStatusView => ({
    ...row.want,
    action: null,
    amount: row.staffAmount ? row.want.amount : null,
    dueOn: row.want.state === "paid_up" ? null : row.want.dueOn,
  });

  it.each(ROWS.map((r) => [r.name, r] as const))("%s: staff projection", (_n, row) => {
    expect(billingStatusOf({ ...row.input, isAdmin: false })).toEqual(staffWant(row));
  });

  it("S1: an OPERATOR on a Stripe due with payNowAmount 149 gets due, amount null, action null", () => {
    const view = billingStatusOf(
      input({ billingState: "due", outstandingTotal: 149, payNowAmount: 149 }, {}, false),
    );
    expect(view).toEqual({ state: "due", amount: null, dueOn: null, action: null });
  });

  it("S2: an OPERATOR on paid_up (next charge 49.50 on Dec 1) gets no amount and no day", () => {
    const view = billingStatusOf(
      input({ nextCharge: { amount: 49.5, date: "2026-12-01T03:00:00.000Z" } }, {}, false),
    );
    expect(view).toEqual({ state: "paid_up", amount: null, dueOn: null, action: null });
  });

  it("S3: an OPERATOR on a catch-up due 49.99 keeps the amount (today's pinned line), no action", () => {
    const view = billingStatusOf(
      input(
        { billingState: undefined },
        { due: true, amountCents: 4999, periodStart: "2026-11-01T05:00:00.000Z" },
        false,
      ),
    );
    expect(view).toEqual({ state: "due", amount: 49.99, dueOn: "2026-11-01", action: null });
  });

  it("with both sources the Stripe invoice wins, so staff get no amount (the catch-up one is not shown)", () => {
    const view = billingStatusOf(
      input(
        { billingState: "due", outstandingTotal: 120 },
        { due: true, amountCents: 4999, periodStart: "2026-11-01T05:00:00.000Z" },
        false,
      ),
    );
    expect(view.amount).toBeNull();
  });
});

describe("hasStaleDunningMarker (S11: logged once per tenant by the service)", () => {
  it("is true only when a marker is set while Stripe answered current", () => {
    const marker = { pastDueInvoiceId: "in_1", pastDueSince: "2026-11-10T20:00:00.000Z" };
    expect(hasStaleDunningMarker(input({ ...marker, billingState: "current" }))).toBe(true);
    expect(hasStaleDunningMarker(input({ ...marker, billingState: "overdue" }))).toBe(false);
    expect(hasStaleDunningMarker(input({ ...marker, billingState: undefined }))).toBe(false);
    expect(hasStaleDunningMarker(input({ billingState: "current" }))).toBe(false);
  });
});

describe("hasTwoPaySources (SA-1146 section 3: the resolver logs once when both exist)", () => {
  it("is true only when a Stripe amount is owed AND the catch-up is due", () => {
    const stripe = { billingState: "due" as const, outstandingTotal: 10 };
    const catchup = { due: true, amountCents: 500 };
    expect(hasTwoPaySources(input(stripe, catchup))).toBe(true);
    expect(hasTwoPaySources(input(stripe, {}))).toBe(false);
    expect(hasTwoPaySources(input({}, catchup))).toBe(false);
  });
});
