import type { SubscriptionView } from "@routeflow/types";

/**
 * SA-733r6 (B4): the ONE pure function behind the billing strip in the dashboard shell and the Settings >
 * Billing card. Everything the user reads comes from here: the signed copy (apple-ux + apple-design), the tone,
 * the action, the dismiss rule. No per-screen copy; no client timer decides state - the server's read does, and
 * this only renders it (the day index is computed from `pastDueSince` against the `now` the caller passes).
 *
 * Rules that bind (the brief's Don't list): never red; no "overdue" / "failed" / "suspended" or blame wording; no
 * countdown; no pay control for anyone but a workspace admin; no "Choose a plan" / "Subscribe" while an invoice
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
  intent: "update-payment" | "pay";
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

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const monthName = (d: Date) => d.toLocaleDateString("en-US", { month: "long" });
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

/** "Dana", or the neutral fallback when no admin is on file. `lead` capitalises it at a sentence start. */
function contact(view: SubscriptionView, lead: boolean): string {
  const name = view.billingContactName?.trim();
  if (name) return name;
  return lead ? "Your admin" : "your admin";
}

/** The sentence a blocked control shows while the workspace is read-only (and a 403 READ_ONLY shows next to it). */
export function readOnlyLine(adminName: string | null | undefined): string {
  const name = adminName?.trim() || "Your admin";
  return `Not available while read-only. ${name} can restore it.`;
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

  // ── An invoice is owed: the grace days, the last day, or the pause ──────────────────────────────────
  const since = view.pastDueSince ? new Date(view.pastDueSince) : null;
  const sinceOk = since && !Number.isNaN(since.getTime()) ? since : null;
  const readOnly = view.status === "READ_ONLY" && ownsBillingBanner(view);

  if (readOnly) {
    const month = monthName(sinceOk ?? now);
    const money =
      view.openInvoiceAmount != null ? ` of ${billingMoney(view.openInvoiceAmount)}` : "";
    return {
      kind: "read-only",
      tone: "amber",
      copy: admin
        ? `Your workspace is read-only until the ${month} payment${money} goes through. Your data is safe.`
        : `Your workspace is read-only. You can still view, print and export. ${contact(view, true)} can restore it.`,
      action: admin ? payAction(view) : null,
      dismiss: null,
      live: "alert",
      inShell: true,
      cardLine: null,
      cardPay: admin && view.pastDueInvoiceId ? payAction(view) : null,
    };
  }

  if (view.pastDueInvoiceId && sinceOk) {
    const cardPay = admin ? payAction(view) : null;
    const elapsedHours = Math.max(0, (now.getTime() - sinceOk.getTime()) / HOUR_MS);
    if (elapsedHours >= FINAL_DAY_HOURS) {
      return {
        kind: "final-day",
        tone: "amber",
        copy: admin
          ? "Your workspace becomes read-only tomorrow. Update your payment to keep everything running."
          : `Your workspace becomes read-only tomorrow. Let ${contact(view, false)} know.`,
        action: admin ? UPDATE_PAYMENT : null,
        dismiss: null,
        live: "alert",
        inShell: true,
        cardLine: null,
        cardPay,
      };
    }
    const dueBy = new Date(sinceOk.getTime() + GRACE_DAYS * DAY_MS);
    return {
      kind: "grace",
      tone: "neutral",
      copy: admin
        ? `We couldn't charge your card for ${monthName(sinceOk)}. Update it by ${shortDate(dueBy)} and nothing changes.`
        : `There's a billing issue. Everything still works. ${contact(view, true)} can sort it out in Billing.`,
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

  // The card is good through the END of its expiry month.
  const expiresOn = new Date(card.expYear, card.expMonth, 0, 23, 59, 59);
  const daysLeft = Math.floor((expiresOn.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft <= CARD_LINE_DAYS) {
    const verb = daysLeft < 0 ? "expired" : "expires";
    const copy = `Your ${brandName(card.brand)} ending ${card.last4} ${verb} ${shortDate(expiresOn)}. Update it to keep autopay running.`;
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
  const nextDate = next ? new Date(next.date) : null;
  const line =
    next && nextDate && !Number.isNaN(nextDate.getTime())
      ? `Autopay is on. Next charge: ${billingMoney(next.amount)} on ${shortDate(nextDate)}.`
      : "Autopay is on.";
  return { ...NONE, kind: "autopay", cardLine: line };
}
