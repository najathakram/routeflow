import type { BillingStatusAction, BillingStatusState, BillingStatusView } from "@routeflow/types";
import {
  BILLING_STATUS_STATES,
  TRIAL_NOTICE_DAYS,
  billingStatusOf,
  hasTwoPaySources,
  type BillingStatusInput,
} from "./billing-status";

/** SA-1146 B-5: every state of the section 1 table, and the role rule, each case red on the WRONG value. */

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
      amount: 0,
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
    name: "MUST 2: nothing positive anywhere is null, never Pay $0 (a lagging dunning marker)",
    input: input({ ...IN_DUNNING, outstandingTotal: 0, payNowAmount: 0, openInvoiceAmount: 0 }),
    want: { state: "failed", amount: null, dueOn: "2026-11-24", action: PAY_INVOICE },
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
    name: "SHOULD d (OBSERVE, pending SA): locked, no reason, dunning marker, Stripe unreachable: today's result is failed",
    // Pending SA: a locked tenant arguably reads read_only. This row documents the CURRENT result only; do not
    // "fix" it here. If the SA rules, change the expected state in the same diff as the code.
    input: input({
      status: "READ_ONLY",
      readOnlyReason: null,
      billingState: undefined,
      pastDueInvoiceId: "in_1",
      pastDueSince: "2026-11-10T20:00:00.000Z",
    }),
    want: { state: "failed", amount: null, dueOn: "2026-11-24", action: PAY_INVOICE },
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
        const unreachable: never = a.kind;
        return unreachable;
      }
    }
  };

  it("names the four kinds in the words C7 uses", () => {
    const kinds: BillingStatusAction["kind"][] = ["pay", "add_card", "change_card", "choose_plan"];
    expect(kinds.map((kind) => label({ kind, target: "checkout" }))).toEqual([
      "Pay",
      "Add card",
      "Change card",
      "Choose a plan",
    ]);
  });

  it("a business with no card gets add_card; no state of the table hands out change_card", () => {
    const kinds = new Set(ROWS.map((r) => billingStatusOf(r.input).action?.kind));
    expect(kinds.has("add_card")).toBe(true);
    expect(kinds.has("change_card")).toBe(false);
  });
});

describe("billingStatusOf: the role rule (staff see the sentence, never a button)", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))("%s: staff get action null", (_n, row) => {
    const staff = billingStatusOf({ ...row.input, isAdmin: false });
    expect(staff).toEqual({ ...row.want, action: null });
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
