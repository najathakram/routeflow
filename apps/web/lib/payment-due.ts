import type { PaymentDueView } from "@routeflow/types";
import { fromCents } from "@routeflow/pricing";
import { formatMoney } from "./format";
import { hasCardReminder, type BannerDismiss, type BannerRole } from "./subscription-banner-state";

/**
 * Row 542: the pure copy model behind the payment-due banner and its failed-renewal variant. Everything the user
 * reads comes from here. The amount, the period and the "is it due" call are the SERVER's (`GET /billing/payment-due`);
 * this only prints them, so no money is computed in the UI (cents go through `fromCents`, then the one money
 * formatter). No em or en dash anywhere in the copy (a customer-facing rule).
 */

export const BILLING_HREF = "/settings/billing";

export type PaymentDueKind = "past-due" | "due" | "failed-renewal" | "card-reminder";

export interface PaymentDueCopy {
  kind: PaymentDueKind;
  title: string;
  body: string;
  /** null for an operator: no pay control for anyone but a workspace admin. */
  primary: { label: string; intent: "pay" | "update-card" } | null;
  secondary: { label: string; href: string };
  /** What an operator is told instead of a pay control. */
  note: string | null;
}

const VIEW_BILLING = { label: "View billing", href: BILLING_HREF } as const;

/** "$100.00" from whole cents; null when the figure is not a payable amount (never prints a guessed number). */
function amountLabel(cents: number): string | null {
  if (!Number.isInteger(cents) || cents <= 0) return null;
  return formatMoney(fromCents(cents));
}

/** The payment-due banner's copy; null when nothing is payable. */
export function paymentDueCopy(
  due: PaymentDueView | null | undefined,
  role: BannerRole,
): PaymentDueCopy | null {
  if (!due || !due.due) return null;
  const amount = amountLabel(due.amountCents);
  if (!amount) return null;
  const period = due.periodLabel ? `${due.periodLabel} subscription` : "subscription";
  const admin = role === "admin";
  return {
    kind: due.pastDue ? "past-due" : "due",
    title: due.pastDue ? "Your payment is past due." : "Your payment is due.",
    body: `Pay ${amount} for your ${period} to keep using RouteFlow.`,
    primary: admin ? { label: "Pay now", intent: "pay" } : null,
    secondary: VIEW_BILLING,
    note: admin ? null : "Ask your account admin to pay.",
  };
}

/** SA-801: an admin can no longer dismiss the card reminder inside this window before the first charge. */
const CARD_REMINDER_LOCK_MS = 7 * 86_400_000;

/** A's calendar day in the tenant's zone, long form ("November 1, 2026"); null for an unusable instant or zone. */
export function formatChargeDate(iso: string, zone: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(t));
  } catch {
    return null;
  }
}

/**
 * SA-801: the card reminder's copy (owner wording). The server decides `cardNeeded` and the date (the planner's first
 * charge A); this only prints A in the tenant's zone. Null when nothing is asked of the tenant.
 */
export function cardReminderCopy(
  due: PaymentDueView | null | undefined,
  role: BannerRole,
  zone: string,
): PaymentDueCopy | null {
  if (!hasCardReminder(due)) return null;
  const date = formatChargeDate(due.chargeStartsOn as string, zone);
  if (!date) return null;
  const admin = role === "admin";
  return {
    kind: "card-reminder",
    title: `Add your card before ${date} to keep RouteFlow running.`,
    body: `You won't be charged until ${date}.`,
    primary: admin ? { label: "Add card", intent: "pay" } : null,
    secondary: VIEW_BILLING,
    note: admin ? null : `Ask your account admin to add a card before ${date}.`,
  };
}

/**
 * SA-801: dismissible for the day for everyone until 7 days before A. From then on an admin cannot dismiss it (it
 * stays until a card is added) while an operator, who cannot act on it, still can, daily. The key carries A.
 */
export function cardReminderDismiss(
  due: PaymentDueView | null | undefined,
  role: BannerRole,
  now: number = Date.now(),
): BannerDismiss | null {
  if (!hasCardReminder(due)) return null;
  const a = Date.parse(due.chargeStartsOn as string);
  if (role === "admin" && now >= a - CARD_REMINDER_LOCK_MS) return null;
  return { scope: "day", key: `card-reminder:${due.chargeStartsOn}` };
}

/** The failed-renewal variant (replaces the strip's grace / overdue kinds). */
export function failedRenewalCopy(role: BannerRole): PaymentDueCopy {
  const admin = role === "admin";
  return {
    kind: "failed-renewal",
    title: "Your last payment didn't go through.",
    body: "Update your card to keep using RouteFlow.",
    primary: admin ? { label: "Update card", intent: "update-card" } : null,
    secondary: VIEW_BILLING,
    note: admin ? null : "Ask your account admin to update the card.",
  };
}
