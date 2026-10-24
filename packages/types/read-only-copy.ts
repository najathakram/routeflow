/**
 * SA-776 (row 382): the ONE composition of the read-only copy for web and mobile.
 *
 *   sentence      the owner's fixed sentence, verbatim;
 *   reasonLine    one line from the tenant's `readOnlyReason` (mapped copy, NEVER server text); null when none;
 *   contactLine   "To restore access, contact your admin ({email})." for a non-admin; null for a TENANT_ADMIN (who
 *                 gets the action - Pay / Choose a plan - instead) and when no email is on file. There is NO name
 *                 in it: the User model has no display-name field, and a username is never shown (lead ruling).
 *
 * Pure: no React, no DOM, no network. Web (`apps/web/lib/read-only-copy.ts`) and mobile
 * (`apps/mobile/lib/read-only-copy.ts`) re-export this module through a thin wrapper, so the strings cannot drift.
 * The buyer-side refusal copy (`SELLER_UNAVAILABLE`) is a different surface and is NOT built here.
 */

export const READ_ONLY_SENTENCE =
  "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.";

/**
 * The two statuses that are NOT read-only: a SUSPENDED or CANCELLED workspace is closed to system-side writes
 * as well, and a surface that refuses one (the Stripe Connect return leg) says which, never "read-only".
 * Amount-free and name-free; the API keeps a literal copy (it never value-imports this package at runtime)
 * that its controller spec pins byte-equal.
 */
export const SUSPENDED_SENTENCE = "This workspace is currently suspended. Please contact support.";
export const CANCELLED_SENTENCE = "This workspace has been cancelled. Please contact support.";

/** The `readOnlyReason` values the server records (tenant-status writers); anything else maps to no reason line. */
export type ReadOnlyReason =
  "trial_expired" | "trial_cancelled" | "subscription_cancelled" | "payment_overdue";

export interface ReadOnlyCopyInput {
  /** `SubscriptionView.readOnlyReason`: null / unknown = set by an administrator (no reason line). */
  reason?: string | null;
  /** `SubscriptionView.openInvoiceAmount`, in dollars. Absent (null) falls back to the amount-free line. */
  overdueAmount?: number | null;
  /** The oldest active TENANT_ADMIN's e-mail (`SubscriptionView.billingContactEmail`); null = no contact line. */
  billingContactEmail?: string | null;
  /** A TENANT_ADMIN sees the action instead of the contact line. */
  isAdmin?: boolean;
  /**
   * A viewer with no admin e-mail to name (a driver: the contact is staff-only data) gets the generic line
   * "To restore access, contact your workspace admin." instead of no contact line at all.
   */
  contactFallback?: boolean;
  /** The caller's money formatter (web passes `formatMoney`); defaults to en-US USD, "$1,490.00". */
  formatMoney?: (dollars: number) => string;
}

export interface ReadOnlyCopy {
  sentence: string;
  reasonLine: string | null;
  contactLine: string | null;
  /** The non-null lines in reading order: sentence, reason, contact. */
  lines: string[];
  /** `lines` joined with a single space, for a toast title / `title` attribute. */
  text: string;
}

function defaultMoney(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

/** The one reason line for a `readOnlyReason`, or null (set by an administrator / unknown value). */
export function readOnlyReasonLine(
  reason: string | null | undefined,
  overdueAmount?: number | null,
  formatMoney: (dollars: number) => string = defaultMoney,
): string | null {
  switch (reason) {
    case "payment_overdue":
      return typeof overdueAmount === "number" && Number.isFinite(overdueAmount)
        ? `Your subscription payment of ${formatMoney(overdueAmount)} is overdue.`
        : "Your subscription payment is overdue.";
    case "trial_expired":
      return "Your free trial has ended.";
    case "subscription_cancelled":
    case "trial_cancelled":
      return "Your subscription was cancelled.";
    default:
      return null;
  }
}

/** The contact line when there is no e-mail to name (opt-in: a driver). */
export const READ_ONLY_CONTACT_FALLBACK = "To restore access, contact your workspace admin.";

/** "To restore access, contact your admin (dana@acme.test)." or null when there is no e-mail on file. */
export function readOnlyContactLine(email: string | null | undefined): string | null {
  const e = email?.trim() || null;
  return e ? `To restore access, contact your admin (${e}).` : null;
}

export function readOnlyCopy(input: ReadOnlyCopyInput = {}): ReadOnlyCopy {
  const reasonLine = readOnlyReasonLine(input.reason, input.overdueAmount, input.formatMoney);
  const contactLine = input.isAdmin
    ? null
    : (readOnlyContactLine(input.billingContactEmail) ??
      (input.contactFallback ? READ_ONLY_CONTACT_FALLBACK : null));
  const lines = [READ_ONLY_SENTENCE, reasonLine, contactLine].filter((l): l is string => !!l);
  return {
    sentence: READ_ONLY_SENTENCE,
    reasonLine,
    contactLine,
    lines,
    text: lines.join(" "),
  };
}

export function readOnlyCopyText(input: ReadOnlyCopyInput = {}): string {
  return readOnlyCopy(input).text;
}
