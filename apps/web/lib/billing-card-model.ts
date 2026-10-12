import type { SubscriptionView } from "@routeflow/types";
import {
  billingMoney,
  isSettling,
  owedAmount,
  payAmountOf,
  type BannerRole,
} from "./subscription-banner-state";

/**
 * SA-777 / billing-ux.md: the Billing card's ONE pure model. Everything the card prints comes from the SERVER's
 * view (`billingState`, `outstandingTotal`, `openInvoiceDueLabel`, ...): the browser never computes a date or a
 * state. Precedence: Read-only > Processing > Overdue > Payment due > Current. Never red.
 *
 * Returns null when the server could not say (no `billingState` and nothing owed): the card then falls back to
 * the legacy autopay line and never claims "Current" it does not know.
 */

export type CardState = "current" | "due" | "overdue" | "processing" | "read-only";

export interface BillingCardModel {
  state: CardState;
  pill: { label: string; tone: "success" | "info" | "warning" | "neutral" };
  /** The 28/34 line: "$149.00 / month", "$149.00 due by Oct 15", ... null hides it (a missing field hides its line). */
  amountLine: string | null;
  /** The 13/18 line under it. */
  subLine: string | null;
  /** "Total open: $298.00 · 2 invoices": only when more is owed than the ONE invoice Pay collects. */
  totalLine: string | null;
  /** Amber text for the sub line ("Card expires 11/26"). */
  subTone: "normal" | "amber";
  /** Admin only; never while a payment is processing. `url` is the oldest owed invoice's hosted page. */
  pay: { label: string; url?: string } | null;
  /** Admin only, every state: "Payment methods & invoices" (the Stripe portal). */
  portal: boolean;
  /** Operator only: who to ask - by email, never the admin's username (owner ruling). */
  contact: { email: string | null } | null;
}

const PILL: Record<CardState, BillingCardModel["pill"]> = {
  current: { label: "Current", tone: "success" },
  due: { label: "Payment due", tone: "info" },
  overdue: { label: "Overdue", tone: "warning" },
  processing: { label: "Processing", tone: "neutral" },
  "read-only": { label: "Read-only", tone: "warning" },
};

const BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};
const brand = (b: string) => BRANDS[b.toLowerCase()] ?? b.charAt(0).toUpperCase() + b.slice(1);

function stateOf(view: SubscriptionView): CardState | null {
  if (view.status === "READ_ONLY") return "read-only";
  if (view.paymentProcessing === true || view.billingState === "processing") return "processing";
  if (view.billingState === "overdue") return "overdue";
  if (view.billingState === "due") return "due";
  if (view.billingState === "current") return "current";
  // An older server (or a Stripe timeout) sent no state: the dunning clock alone still says "overdue"; otherwise unknown.
  return view.pastDueInvoiceId ? "overdue" : null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "$149.00 due by Oct 15" / "Due by Oct 15" / "$149.00 due": the words are the spec's, the pieces are optional. */
function owedLine(
  amount: number | null,
  lead: "due" | "overdue",
  label: string | undefined,
): string | null {
  const when = label ? (lead === "due" ? ` by ${label}` : ` since ${label}`) : "";
  if (amount == null && !label) return null;
  return amount != null ? `${billingMoney(amount)} ${lead}${when}` : `${cap(lead)}${when}`;
}

function cardExpiry(
  card: NonNullable<SubscriptionView["paymentMethodSummary"]>,
  now: Date,
): string | null {
  // good through the END of its expiry month; pure calendar arithmetic (UTC), no zone
  const endMs = Date.UTC(card.expYear, card.expMonth, 1) - 1000;
  if ((endMs - now.getTime()) / 86_400_000 > 30) return null;
  return `Card expires ${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

export function billingCardModel(
  view: SubscriptionView | null | undefined,
  role: BannerRole | null,
  now: Date = new Date(),
): BillingCardModel | null {
  if (!view || !role) return null;
  const state = stateOf(view);
  if (!state) return null;
  const admin = role === "admin";
  // Pay collects ONE invoice: every amount next to it is that invoice's. The total of all open invoices is named
  // underneath when it is larger (and while settling, where nothing is payable, the total IS the line).
  const total = owedAmount(view);
  const payable = payAmountOf(view);
  const amount = state === "processing" ? total : payable;
  const label = view.openInvoiceDueLabel ?? undefined;
  const planLine = `${view.planName} plan, ${view.cycle === "ANNUAL" ? "annual" : "monthly"}`;

  let amountLine: string | null = null;
  let subLine: string | null = planLine;
  let subTone: BillingCardModel["subTone"] = "normal";

  if (state === "current") {
    const price = view.cycle === "ANNUAL" ? view.annualPrice : view.monthlyPrice;
    amountLine =
      price != null && !view.isCustom
        ? `${billingMoney(price)} / ${view.cycle === "ANNUAL" ? "year" : "month"}`
        : null;
    // Autopay facts are an admin's (the API trims them for an operator); a missing part hides itself.
    const card = view.paymentMethodSummary;
    const next = view.nextCharge;
    const parts = [
      card ? "Autopay on" : null,
      card ? `${brand(card.brand)} •••• ${card.last4}` : null,
      next?.dateLabel ? `next charge ${next.dateLabel}` : null,
    ].filter((p): p is string => !!p);
    const expiring = card ? cardExpiry(card, now) : null;
    if (expiring) {
      subLine = expiring;
      subTone = "amber";
    } else if (parts.length > 0) {
      subLine = parts.join(" · ");
    }
  } else if (state === "due") {
    amountLine = owedLine(amount, "due", label);
  } else if (state === "overdue") {
    amountLine = owedLine(amount, "overdue", label);
  } else if (state === "processing") {
    const words = "payment processing — usually 3–5 business days";
    amountLine = amount != null ? `${billingMoney(amount)} ${words}` : cap(words);
  } else if (view.readOnlyReason === "payment_overdue" && !isSettling(view)) {
    amountLine = owedLine(amount, "overdue", label);
  }

  // Pay: due / overdue / read-only-because-unpaid, admins only, never while a payment is settling.
  const canPay =
    admin &&
    !isSettling(view) &&
    (state === "due" ||
      state === "overdue" ||
      (state === "read-only" && view.readOnlyReason === "payment_overdue"));
  const pay = canPay
    ? {
        label: payable != null && payable > 0 ? `Pay ${billingMoney(payable)}` : "Pay now",
        ...(view.payNowUrl ? { url: view.payNowUrl } : {}),
      }
    : null;

  // "Total open: $298.00 · 2 invoices (1 processing)": only when more is owed than the one invoice Pay collects,
  // naming what is already settling so the second figure is never read as still to pay.
  const count = view.openInvoiceCount;
  const settling = view.settlingCount ?? 0;
  const totalLine =
    pay && total != null && payable != null && total > payable + 0.005
      ? `Total open: ${billingMoney(total)}${count != null && count > 1 ? ` · ${count} invoices` : ""}${
          settling > 0 ? ` (${settling} processing)` : ""
        }`
      : null;

  return {
    state,
    pill: PILL[state],
    amountLine,
    subLine,
    totalLine,
    subTone,
    pay,
    portal: admin,
    contact: admin ? null : { email: view.billingContactEmail ?? null },
  };
}
