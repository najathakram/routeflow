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
 * `action` is set only for a role that `seesBillingMoney`; staff get the same state with `action: null`, and an amount
 * only for the catch-up bill (the one amount they see today, SA-1150 1a); never a Stripe figure, never the next-charge day.
 */
import { fromCents, roundMoney } from "@routeflow/pricing";
import {
  TRIAL_NOTICE_DAYS,
  type BillingStatusAction,
  type BillingStatusState,
  type BillingStatusView,
  type SubscriptionView,
  type TenantStatusValue,
} from "@routeflow/types";
import { DUNNING_PAUSE_HOURS, HOUR_MS } from "./dunning-config";
import type { PaymentDueView } from "./payment-due.service";

/** Typed against the shared enum (a typo or a renamed status fails to compile), never a bare string. */
const tenantStatus = <T extends TenantStatusValue>(v: T): T => v;
const TRIAL = tenantStatus("TRIAL");
const ACTIVE = tenantStatus("ACTIVE");
const READ_ONLY = tenantStatus("READ_ONLY");

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
  | "openInvoiceDueAt"
>;

export interface BillingStatusInput {
  subscription: BillingStatusSubscription;
  paymentDue: PaymentDueView;
  now: Date;
  /** The tenant's IANA zone (`resolveZone`): every day in the view is a day on THIS clock. */
  timeZone: string;
  /** `seesBillingMoney(role)`: only such a role is handed an action and the Stripe money (SA-1150 1a). */
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

/** True when a dunning marker is set but Stripe already answered `current` (the marker lags `invoice.paid`); the caller logs once. */
export function hasStaleDunningMarker(i: BillingStatusInput): boolean {
  return Boolean(i.subscription.pastDueInvoiceId) && i.subscription.billingState === "current";
}

/** Whole tenant-calendar days from `from` to `to` (both on the tenant's clock; DST cannot skew a calendar count). */
function calendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);
  return Math.round((utc(dayIn(to, timeZone)) - utc(dayIn(from, timeZone))) / DAY_MS);
}

/** True when BOTH pay sources exist (they are mutually exclusive by construction); the caller logs once. */
export function hasTwoPaySources(i: BillingStatusInput): boolean {
  return stripeOwes(i.subscription) && i.paymentDue.due;
}

/** S8: a Pay button needs a figure to collect. No positive figure means no Pay action (the state and its sentence stay). */
const payWith = (action: BillingStatusAction, amount: number | null): BillingStatusAction | null =>
  amount === null ? null : action;

const NONE: BillingStatusView = { state: "none", amount: null, dueOn: null, action: null };

export function billingStatusOf(i: BillingStatusInput): BillingStatusView {
  const { view, staffAmount } = decide(i);
  if (i.isAdmin) return view;
  // Staff: exactly the money they see today, per source. The catch-up bill stays (`staffAmount`); every Stripe figure
  // is hidden (SA-777); the next-charge day is hidden too. Every other day is a label staff already see.
  return {
    ...view,
    action: null,
    amount: staffAmount ? view.amount : null,
    dueOn: view.state === "paid_up" ? null : view.dueOn,
  };
}

interface Decision {
  view: BillingStatusView;
  /** True only on the catch-up `due` branch: the one amount a non-admin sees. */
  staffAmount: boolean;
}

function decide(i: BillingStatusInput): Decision {
  const { subscription: s, paymentDue: d, now, timeZone } = i;
  const owed = stripeAmount(s, false);
  const payAmount = stripeAmount(s, true); // every hosted_invoice state below
  const make = (
    state: BillingStatusState,
    over: Partial<BillingStatusView>,
    staffAmount = false,
  ): Decision => ({ view: { ...NONE, state, ...over }, staffAmount });
  const none: Decision = { view: NONE, staffAmount: false };

  // A settling payment with nothing else payable: just say so (the server already ruled a sibling unpaid invoice out).
  if (s.billingState === "processing") {
    return make("processing", { amount: owed });
  }

  const locked = s.status === READ_ONLY;
  const reason = s.readOnlyReason ?? null;
  const trialReason = reason === "trial_expired" || reason === "trial_cancelled";
  const trialEnd = s.trialEndsAt ? new Date(s.trialEndsAt) : null;

  if (locked && trialReason) return make("trial_ended", { action: CHOOSE_PLAN });
  if (
    locked &&
    reason !== "subscription_cancelled" &&
    // no recorded reason but a dunning marker is a lock for an unpaid amount too, even when Stripe is unreachable (S10)
    (reason === "payment_overdue" ||
      stripeOwes(s) ||
      (reason === null && Boolean(s.pastDueInvoiceId)))
  ) {
    return make("read_only", { amount: payAmount, action: payWith(PAY_INVOICE, payAmount) });
  }
  if (s.status === TRIAL && trialEnd && trialEnd.getTime() <= now.getTime()) {
    return make("trial_ended", { action: CHOOSE_PLAN });
  }

  // A marker that lags `invoice.paid` while Stripe already says current is NOT dunning (S11): say nothing (not failed, and not paid_up while a marker is set).
  if (hasStaleDunningMarker(i)) return none;
  if (s.pastDueInvoiceId) {
    const since = s.pastDueSince ? new Date(s.pastDueSince) : null;
    return make("failed", {
      amount: payAmount,
      dueOn: since
        ? dayIn(new Date(since.getTime() + DUNNING_PAUSE_HOURS * HOUR_MS), timeZone)
        : null,
      action: payWith(PAY_INVOICE, payAmount),
    });
  }

  // Both sources present: the Stripe invoice is the one Stripe will actually charge.
  if (stripeOwes(s)) {
    return make("due", {
      amount: payAmount,
      action: payWith(PAY_INVOICE, payAmount),
      dueOn: s.openInvoiceDueAt ? dayIn(s.openInvoiceDueAt, timeZone) : null,
    });
  }
  if (d.due) {
    const catchUp = positive(fromCents(d.amountCents)); // 0 cents is no figure (S8)
    return make(
      "due",
      {
        amount: catchUp,
        dueOn: d.periodStart ? dayIn(d.periodStart, timeZone) : null,
        action: payWith(PAY_CHECKOUT, catchUp),
      },
      true, // the catch-up bill is the one amount staff see today (payment-due.test.ts), so it stays
    );
  }
  if (d.cardNeeded) {
    return make("due", {
      amount: null, // nothing is charged now: no figure, never $0 (SA-1150 S6)
      dueOn: d.cardBy ? dayIn(d.cardBy, timeZone) : null,
      action: ADD_CARD,
    });
  }

  if (s.status === TRIAL && trialEnd) {
    // Tenant CALENDAR days, not 24 h blocks (S13): a trial ending at 23:30 local, seven days ahead, is inside the window.
    if (calendarDaysBetween(now, trialEnd, timeZone) <= TRIAL_NOTICE_DAYS) {
      return make("trial", { dueOn: dayIn(trialEnd, timeZone), action: CHOOSE_PLAN });
    }
    return none;
  }

  // Never "paid up" on a guess: Stripe must have answered (`billingState === "current"`), a card must be on file, and
  // a next charge must exist (it proves a subscription; the sentence needs both figures, S12).
  if (
    s.status === ACTIVE &&
    s.billingState === "current" &&
    s.paymentMethodSummary &&
    s.nextCharge
  ) {
    return make("paid_up", {
      amount: roundMoney(s.nextCharge.amount),
      dueOn: dayIn(s.nextCharge.date, timeZone),
    });
  }
  return none;
}
