/**
 * SA-1146 B-5: the ONE billing status. A pure function (no I/O, no clock of its own) over the two reads that already
 * exist - the subscription view (`billingState`, `pastDueInvoiceId`, `trialEndsAt`, ...) and the payment-due view
 * (the catch-up planner's) - returning the single `BillingStatusView` every surface renders: shell banner, strip,
 * Billing status card, Settings card, blocked-save toast. The server decides the state AND the action; the web only
 * prints them. Words and sentences live in the web's shared vocabulary (B-2), never here.
 *
 * Precedence, highest first (each is one state of SA-1146 section 1):
 *   processing   a payment is settling and nothing else is payable (B1256: never shown as failed or received)
 *   read_only    locked for an unpaid amount          -> Pay $X, the hosted invoice
 *   trial_ended  trial expired (status TRIAL past its end, or locked for `trial_expired`) -> Choose a plan
 *   failed       inside dunning (`pastDueInvoiceId`)  -> Pay $X, the hosted invoice (`invoice.paid` is the ONLY resume)
 *   due          an open Stripe amount, or the catch-up bill, or a card the catch-up needs
 *   trial        trial ends within TRIAL_NOTICE_DAYS  -> Choose a plan
 *   paid_up      nothing owed, automatic payment on (a card on file), Stripe answered
 *   none         anything else (Stripe could not answer, no card, a trial far from its end): say nothing
 * `action` is set only for a TENANT_ADMIN; staff get the same state and amount with `action: null`.
 */
import { fromCents, roundMoney } from "@routeflow/pricing";
import type {
  BillingStatusAction,
  BillingStatusState,
  BillingStatusView,
  SubscriptionView,
} from "@routeflow/types";
import { DUNNING_PAUSE_HOURS, HOUR_MS } from "./dunning-config";
import type { PaymentDueView } from "./payment-due.service";

/** One constant for the trial notice (the same 7 days as the 7-day trial email). */
export const TRIAL_NOTICE_DAYS = 7;

const DAY_MS = 24 * HOUR_MS;

/** Every state, as a runtime list (the spec pins it equal to the union; the `Record` makes a new member fail to compile). */
const STATE_SET: Record<BillingStatusState, true> = {
  paid_up: true,
  due: true,
  failed: true,
  read_only: true,
  processing: true,
  trial: true,
  trial_ended: true,
  none: true,
};
export const BILLING_STATUS_STATES = Object.keys(STATE_SET) as BillingStatusState[];

/** What the status needs of the subscription read (the full, admin-grade view: an operator's trimmed one lacks amounts). */
export type BillingStatusSubscription = Pick<
  SubscriptionView<Date | string>,
  | "status"
  | "trialEndsAt"
  | "readOnlyReason"
  | "pastDueInvoiceId"
  | "pastDueSince"
  | "paymentMethodSummary"
  | "nextCharge"
  | "billingState"
  | "paymentProcessing"
  | "outstandingTotal"
  | "payNowAmount"
  | "openInvoiceAmount"
>;

export interface BillingStatusInput {
  subscription: BillingStatusSubscription;
  paymentDue: PaymentDueView;
  now: Date;
  /** The tenant's IANA zone (`resolveZone`): every day in the view is a day on THIS clock. */
  timeZone: string;
  /** Decided by the server from the JWT role; only a TENANT_ADMIN is handed an action. */
  isAdmin: boolean;
}

const PAY_INVOICE: BillingStatusAction = { kind: "pay", target: "hosted_invoice" };
const PAY_CHECKOUT: BillingStatusAction = { kind: "pay", target: "checkout" };
// A business with NO card on file adds one (SA-1146 C7). `change_card` (replace the card on file) is never a state's
// primary action: it is a secondary link the web owns.
const ADD_CARD: BillingStatusAction = { kind: "add_card", target: "checkout" };
const CHOOSE_PLAN: BillingStatusAction = { kind: "choose_plan", target: "choose_plan" };

/** A calendar day, "YYYY-MM-DD", on the tenant's clock (en-CA formats year-month-day, which sorts as a string). */
function dayIn(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof iso === "string" ? new Date(iso) : iso);
}

/** A figure worth printing: rounded once, and strictly positive (a zero or negative is "no figure", never "Pay $0"). */
function positive(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const rounded = roundMoney(n);
  return rounded > 0 ? rounded : null;
}

/**
 * The Stripe amount a state shows, in dollars, rounded once; null when nothing positive is owed.
 *
 * - `oneInvoice` (the state's button is `hosted_invoice`: due, failed, read_only): the figure is what that button
 *   COLLECTS, the ONE payable invoice's `payNowAmount` (the house rule, `payAmountOf` in the web's
 *   subscription-banner-state). Only when that is not a positive figure does it fall back to what is owed.
 * - otherwise (`processing`: no button): everything owed or settling (`outstandingTotal` first), because the sentence
 *   says what is in flight, not what a link would collect.
 * Fallback order, after the pay-now figure: outstandingTotal, then openInvoiceAmount.
 */
function stripeAmount(s: BillingStatusSubscription, oneInvoice: boolean): number | null {
  const owed =
    positive(s.outstandingTotal) ?? positive(s.payNowAmount) ?? positive(s.openInvoiceAmount);
  return oneInvoice ? (positive(s.payNowAmount) ?? owed) : owed;
}

const stripeOwes = (s: BillingStatusSubscription) =>
  s.billingState === "due" || s.billingState === "overdue";

/** True when BOTH pay sources exist (they are mutually exclusive by construction); the caller logs once. */
export function hasTwoPaySources(i: BillingStatusInput): boolean {
  return stripeOwes(i.subscription) && i.paymentDue.due;
}

const NONE: BillingStatusView = { state: "none", amount: null, dueOn: null, action: null };

export function billingStatusOf(i: BillingStatusInput): BillingStatusView {
  const view = decide(i);
  return i.isAdmin ? view : { ...view, action: null };
}

function decide({ subscription: s, paymentDue: d, now, timeZone }: BillingStatusInput) {
  const owed = stripeAmount(s, false);
  const payAmount = stripeAmount(s, true); // every hosted_invoice state below
  const make = (
    state: BillingStatusState,
    over: Partial<BillingStatusView>,
  ): BillingStatusView => ({ ...NONE, state, ...over });

  // A settling payment with nothing else payable: just say so (the server already ruled a sibling unpaid invoice out).
  if (s.billingState === "processing") {
    return make("processing", { amount: owed });
  }

  const locked = s.status === "READ_ONLY";
  const reason = s.readOnlyReason ?? null;
  const trialReason = reason === "trial_expired" || reason === "trial_cancelled";
  const trialEnd = s.trialEndsAt ? new Date(s.trialEndsAt) : null;

  if (locked && trialReason) return make("trial_ended", { action: CHOOSE_PLAN });
  if (
    locked &&
    reason !== "subscription_cancelled" &&
    (reason === "payment_overdue" || stripeOwes(s))
  ) {
    return make("read_only", { amount: payAmount, action: PAY_INVOICE });
  }
  if (s.status === "TRIAL" && trialEnd && trialEnd.getTime() <= now.getTime()) {
    return make("trial_ended", { action: CHOOSE_PLAN });
  }

  if (s.pastDueInvoiceId) {
    const since = s.pastDueSince ? new Date(s.pastDueSince) : null;
    return make("failed", {
      amount: payAmount,
      dueOn: since
        ? dayIn(new Date(since.getTime() + DUNNING_PAUSE_HOURS * HOUR_MS), timeZone)
        : null,
      action: PAY_INVOICE,
    });
  }

  // Both sources present: the Stripe invoice is the one Stripe will actually charge.
  if (stripeOwes(s)) return make("due", { amount: payAmount, action: PAY_INVOICE });
  if (d.due) {
    return make("due", {
      amount: fromCents(d.amountCents),
      dueOn: d.periodStart ? dayIn(d.periodStart, timeZone) : null,
      action: PAY_CHECKOUT,
    });
  }
  if (d.cardNeeded) {
    return make("due", {
      amount: 0,
      dueOn: d.cardBy ? dayIn(d.cardBy, timeZone) : null,
      action: ADD_CARD,
    });
  }

  if (s.status === "TRIAL" && trialEnd) {
    if (trialEnd.getTime() - now.getTime() <= TRIAL_NOTICE_DAYS * DAY_MS) {
      return make("trial", { dueOn: dayIn(trialEnd, timeZone), action: CHOOSE_PLAN });
    }
    return NONE;
  }

  // Never "paid up" on a guess: Stripe must have answered (`billingState === "current"`) and a card must be on file.
  if (s.status === "ACTIVE" && s.billingState === "current" && s.paymentMethodSummary) {
    return make("paid_up", {
      amount: s.nextCharge ? roundMoney(s.nextCharge.amount) : null,
      dueOn: s.nextCharge ? dayIn(s.nextCharge.date, timeZone) : null,
    });
  }
  return NONE;
}
