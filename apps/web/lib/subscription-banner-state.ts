import type { SubscriptionView } from "@routeflow/types";
import { readOnlyCopyForView } from "./read-only-copy";

/**
 * SA-733r6 (B4): the ONE pure function behind the billing strip in the dashboard shell and the Settings >
 * Billing card. Everything the user reads comes from here: the signed copy (apple-ux + apple-design), the tone,
 * the action, the dismiss rule. No per-screen copy; no client timer decides state - the server's read does, and
 * this only renders it (the day index is computed from `pastDueSince` against the `now` the caller passes).
 *
 * Rules that bind (the brief's Don't list): never red; no "overdue" / "failed" / "suspended" or blame wording (the
 * read-only states are the one exception: the owner's SA-776 copy, composed in `read-only-copy.ts`, names the
 * reason, e.g. "Your subscription payment of $149.00 is overdue."); no countdown; no pay control for anyone but a workspace admin; no "Choose a plan" / "Subscribe" while an invoice
 * is owed; no billing state for buyers; amounts always print as money ($149.00), never a dash.
 */

export type BannerRole = "admin" | "staff";

/** Who sees billing state. Buyers (CUSTOMER) and drivers get none - the caller renders nothing for `null`. */
export function bannerRoleOf(userRole: string | null | undefined): BannerRole | null {
  if (userRole === "TENANT_ADMIN") return "admin";
  if (userRole === "OPERATOR") return "staff";
  return null;
}

export interface BannerAction {
  label: string;
  /** "update-payment" opens the Stripe billing portal; "pay" opens the owed invoice's hosted page. */
  intent: "update-payment" | "pay" | "open-billing";
}

export interface BannerDismiss {
  /** "day": gone for the rest of that local day; "week": gone for 7 days. */
  scope: "day" | "week";
  key: string;
}

export interface BannerState {
  kind: "none" | "autopay" | "card-expiring" | "grace" | "final-day" | "read-only";
  /** Grace is neutral (blue); the last day and read-only are amber. Never red. */
  tone: "none" | "neutral" | "amber";
  /** The full strip text ("" when there is no strip). */
  copy: string;
  /** The strip's action; null for operators (no pay control in the DOM). */
  action: BannerAction | null;
  /** null = not dismissible (last day, read-only). */
  dismiss: BannerDismiss | null;
  /** `status` in grace, `alert` once on the last day and read-only. */
  live: "status" | "alert" | null;
  /** Whether the shell strip shows at all. */
  inShell: boolean;
  /** The status line on the Billing card (autopay, expiring card). */
  cardLine: string | null;
  /** "Pay $149.00" - primary at the top of the Billing card whenever an invoice is owed (admins only). */
  cardPay: BannerAction | null;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Day 6 starts at +144 h (the server's d6 milestone); the pause waits for the first 03:00 after +168 h. */
const FINAL_DAY_HOURS = 144;
/** The grace window: the date the copy asks the admin to update by. */
const GRACE_DAYS = 7;
const CARD_LINE_DAYS = 14;
const CARD_STRIP_DAYS = 7;
/** While a billing state shows, re-read the subscription at least this often so a payment clears the strip <= 60 s. */
const POLL_MS = 30_000;

const NONE: BannerState = {
  kind: "none",
  tone: "none",
  copy: "",
  action: null,
  dismiss: null,
  live: null,
  inShell: false,
  cardLine: null,
  cardPay: null,
};

/** $149.00 - always cents, always a figure. */
export function billingMoney(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/**
 * Labels are formatted by the SERVER in the tenant's zone (SA-738) and rendered verbatim. These UTC helpers are only
 * the fallback for an older server that sends none - never the browser's zone.
 */
const utcMonth = (d: Date) => MONTHS_LONG[d.getUTCMonth()] ?? "";
const utcDay = (d: Date) => `${MONTHS_SHORT[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`;
const utcDayOrNull = (iso: string): string | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : utcDay(d);
};
/** Local calendar date key, for the "dismissed for the day" rule. */
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};
const brandName = (b: string) => BRANDS[b.toLowerCase()] ?? b.charAt(0).toUpperCase() + b.slice(1);

/** Who a non-admin is told to ask. There is no contact NAME (SA-776: a username is never shown). */
function contact(lead: boolean): string {
  return lead ? "Your admin" : "your admin";
}

/**
 * The line a blocked control shows while the workspace is read-only (and a 403 READ_ONLY toast shows): the owner's
 * sentence + the mapped reason + (non-admin) the contact, from `read-only-copy.ts` (SA-776).
 */
export function readOnlyLine(view: SubscriptionView | null | undefined, isAdmin: boolean): string {
  return readOnlyCopyForView(view, isAdmin).text;
}

/** True when this view's read-only / grace state is the billing strip's, not the trial banner's. */
export function ownsBillingBanner(view: SubscriptionView | null | undefined): boolean {
  return !!view && (view.readOnlyReason === "payment_overdue" || !!view.pastDueInvoiceId);
}

/** React-query `refetchInterval` for the subscription read: poll while a billing state is showing. */
export function subscriptionPollInterval(
  view: SubscriptionView | null | undefined,
): number | false {
  return ownsBillingBanner(view) ? POLL_MS : false;
}

const payAction = (view: SubscriptionView): BannerAction => ({
  label: view.openInvoiceAmount != null ? `Pay ${billingMoney(view.openInvoiceAmount)}` : "Pay now",
  intent: "pay",
});
const UPDATE_PAYMENT: BannerAction = { label: "Update payment", intent: "update-payment" };

export function subscriptionBannerState(
  view: SubscriptionView | null | undefined,
  role: BannerRole,
  now: Date = new Date(),
): BannerState {
  if (!view) return NONE;
  const admin = role === "admin";

  const since = view.pastDueSince ? new Date(view.pastDueSince) : null;
  const sinceOk = since && !Number.isNaN(since.getTime()) ? since : null;
  const readOnly = view.status === "READ_ONLY" && ownsBillingBanner(view);

  // ── Paused (read-only) ───────────────────────────────────────────────────────────────────────────────
  if (readOnly) {
    // SA-776: the owner's sentence + the mapped reason line (+ the contact line for a non-admin), composed in ONE
    // place. A cancel, not an unpaid invoice, can be what holds this workspace read-only (S7): the reason line then
    // says "cancelled" and nothing promises that paying restores it; the admin gets a Billing link, never Pay.
    const copy = readOnlyCopyForView(view, admin).text;
    if (view.readOnlyReason !== "payment_overdue") {
      return {
        kind: "read-only",
        tone: "amber",
        copy,
        action: admin ? { label: "Billing", intent: "open-billing" } : null,
        dismiss: null,
        live: "alert",
        inShell: true,
        cardLine: null,
        cardPay: null,
      };
    }
    return {
      kind: "read-only",
      tone: "amber",
      copy,
      action: admin ? payAction(view) : null,
      dismiss: null,
      live: "alert",
      inShell: true,
      cardLine: null,
      cardPay: admin && view.pastDueInvoiceId ? payAction(view) : null,
    };
  }

  // ── An invoice is owed, the workspace still works: grace, or (only when the pause is real) the last day ─
  if (view.pastDueInvoiceId) {
    const cardPay = admin ? payAction(view) : null;
    const elapsedHours = sinceOk ? Math.max(0, (now.getTime() - sinceOk.getTime()) / HOUR_MS) : 0;
    // B2: the last-day escalation (amber, "read-only tomorrow") exists ONLY when the server really pauses
    // (BILLING_PAUSE_MODE=enforced). In dark / off nothing will happen on day 7, so nothing is threatened.
    if (view.pauseEnforced === true && elapsedHours >= FINAL_DAY_HOURS) {
      return {
        kind: "final-day",
        tone: "amber",
        copy: admin
          ? "Your workspace becomes read-only tomorrow. Update your payment to keep everything running."
          : `Your workspace becomes read-only tomorrow. Let ${contact(false)} know.`,
        action: admin ? UPDATE_PAYMENT : null,
        dismiss: null,
        live: "alert",
        inShell: true,
        cardLine: null,
        cardPay,
      };
    }
    const monthKnown = view.pastDueMonthLabel ?? (sinceOk ? utcMonth(sinceOk) : null);
    const forMonth = monthKnown ? ` for ${monthKnown}` : "";
    const dueBy =
      view.graceEndsLabel ??
      (sinceOk ? utcDay(new Date(sinceOk.getTime() + GRACE_DAYS * DAY_MS)) : null);
    // A deadline is only claimed when the pause is real AND we know the date; otherwise the neutral card-update copy.
    const adminCopy =
      view.pauseEnforced === true && dueBy
        ? `We couldn't charge your card${forMonth}. Update it by ${dueBy} and nothing changes.`
        : `We couldn't charge your card${forMonth}. Update it to keep autopay running.`;
    return {
      kind: "grace",
      tone: "neutral",
      copy: admin
        ? adminCopy
        : `There's a billing issue. Everything still works. ${contact(true)} can sort it out in Billing.`,
      action: admin ? UPDATE_PAYMENT : null,
      dismiss: { scope: "day", key: `grace:${view.pastDueInvoiceId}:${dayKey(now)}` },
      live: "status",
      inShell: true,
      cardLine: null,
      cardPay,
    };
  }

  // ── Nothing owed: the admin's autopay card and the expiring-card nudge (operators see neither) ──────
  if (!admin || view.status !== "ACTIVE") return NONE;
  const card = view.paymentMethodSummary;
  if (!card) return NONE;

  // The card is good through the END of its expiry month. Pure calendar arithmetic (UTC), no zone.
  const expiresEndMs = Date.UTC(card.expYear, card.expMonth, 1) - 1000;
  const daysLeft = Math.floor((expiresEndMs - now.getTime()) / DAY_MS);
  if (daysLeft <= CARD_LINE_DAYS) {
    const lastDay = new Date(Date.UTC(card.expYear, card.expMonth, 0)).getUTCDate();
    const expiresLabel = `${MONTHS_SHORT[card.expMonth - 1] ?? ""} ${lastDay}`;
    const verb = daysLeft < 0 ? "expired" : "expires";
    const copy = `Your ${brandName(card.brand)} ending ${card.last4} ${verb} ${expiresLabel}. Update it to keep autopay running.`;
    const inShell = daysLeft <= CARD_STRIP_DAYS;
    return {
      kind: "card-expiring",
      tone: inShell ? "neutral" : "none",
      copy: inShell ? copy : "",
      action: inShell ? UPDATE_PAYMENT : null,
      dismiss: inShell
        ? { scope: "week", key: `card:${card.last4}:${card.expYear}-${card.expMonth}` }
        : null,
      live: inShell ? "status" : null,
      inShell,
      cardLine: copy,
      cardPay: null,
    };
  }

  if (view.cancelAtPeriodEnd) return NONE;
  const next = view.nextCharge;
  const nextLabel = next ? (next.dateLabel ?? utcDayOrNull(next.date)) : null;
  const line =
    next && nextLabel
      ? `Autopay is on. Next charge: ${billingMoney(next.amount)} on ${nextLabel}.`
      : "Autopay is on.";
  return { ...NONE, kind: "autopay", cardLine: line };
}
