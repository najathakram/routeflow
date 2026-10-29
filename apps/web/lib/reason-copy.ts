import { RUN_UNFINALIZED_PREFIX } from "./api/invoices";
import type { ReturnReason } from "./api/returns";
import { isReadOnlyRefusal, readOnlyRefusalCopy } from "./read-only-refusal";

/**
 * PLACEHOLDER closed sets for the email-delivery health strip. The authoritative `EmailReasonCode`
 * Prisma enum (+ its `X_VALUES` mirror in `packages/types/api/enums.ts`, L-072) ships with the
 * EmailDelivery bundle; when it lands, replace these two const arrays with that import. Until then
 * the strip sits behind the 404 feature-detect in `useDeliveryHealth()` and an unknown code falls
 * back to a generic sentence, so a drifting set can never print raw text.
 */
export const DELIVERY_REASON_CODE_VALUES = [
  "RULE_OFF",
  "NO_RECIPIENT",
  "OPTED_OUT",
  "NO_FROM_ADDRESS",
  "MAILBOX_REVOKED",
  "SMTP_AUTH",
  "TRANSPORT_ERROR",
  "RECIPIENT_REJECTED",
  "UNKNOWN",
] as const;
export type DeliveryReasonCode = (typeof DELIVERY_REASON_CODE_VALUES)[number];

export const DELIVERY_FIX_LINK_VALUES = [
  "SETTINGS_EMAIL",
  "SETTINGS_NOTIFICATIONS",
  "MY_ACCOUNT",
  "NONE",
] as const;
export type DeliveryFixLink = (typeof DELIVERY_FIX_LINK_VALUES)[number];

/** Placeholder shape of `GET /messaging/delivery-health` (see above). */
export interface DeliveryHealth {
  windowDays: number;
  sent: number;
  failed: number;
  skipped: number;
  byReason: Array<{ reasonCode: string; count: number; fixLink: string }>;
}

/**
 * App-wide rule (#1965, spec 10): UI renders a sentence from a CLOSED code -> copy map, with a
 * fix action where one exists. A raw `error` / `reason` / `message` string from the API or a
 * provider never goes into a cell, badge or toast body. Unknown codes fall back to a generic
 * sentence and are never echoed.
 */

const GENERIC = "Not sent for a reason we couldn't identify.";

/** One closed clause per reason; `skipped` = we chose not to send (vs. tried and failed). */
const DELIVERY_REASON_CLAUSE: Record<DeliveryReasonCode, { clause: string; skipped: boolean }> = {
  RULE_OFF: { clause: "this notification is switched off", skipped: true },
  NO_RECIPIENT: { clause: "the customer has no email address", skipped: true },
  OPTED_OUT: { clause: "the recipient opted out", skipped: true },
  NO_FROM_ADDRESS: { clause: "no sending email address is set up", skipped: false },
  MAILBOX_REVOKED: { clause: "the connected mailbox lost access", skipped: false },
  SMTP_AUTH: { clause: "the email account sign-in was rejected", skipped: false },
  TRANSPORT_ERROR: { clause: "the email service had a delivery problem", skipped: false },
  RECIPIENT_REJECTED: {
    clause: "the recipient's mail server rejected the message",
    skipped: false,
  },
  UNKNOWN: { clause: "", skipped: false },
};

const knownReason = (code: string): code is DeliveryReasonCode =>
  Object.prototype.hasOwnProperty.call(DELIVERY_REASON_CLAUSE, code);

export function describeDeliveryReason(code: string): string {
  if (!knownReason(code) || code === "UNKNOWN") return GENERIC;
  const r = DELIVERY_REASON_CLAUSE[code];
  return `${r.skipped ? "Skipped" : "Not sent"} because ${r.clause}.`;
}

/** "2 emails weren't sent: no sending email address is set up." (count in the sentence, no raw code). */
export function describeDeliveryOutcome(code: string, count: number): string {
  const one = count === 1;
  const known = knownReason(code) && code !== "UNKNOWN" ? DELIVERY_REASON_CLAUSE[code] : null;
  if (!known)
    return `${count} ${one ? "email" : "emails"} ${one ? "wasn't" : "weren't"} sent for a reason we couldn't identify.`;
  const verb = known.skipped
    ? one
      ? "was skipped"
      : "were skipped"
    : one
      ? "wasn't sent"
      : "weren't sent";
  return `${count} ${one ? "email" : "emails"} ${verb}: ${known.clause}.`;
}

const DELIVERY_FIX_TARGET: Record<DeliveryFixLink, { label: string; href: string } | null> = {
  SETTINGS_EMAIL: { label: "Set up email", href: "/settings?tab=email" },
  SETTINGS_NOTIFICATIONS: {
    label: "Review notification settings",
    href: "/settings?tab=notifications",
  },
  MY_ACCOUNT: { label: "Open my account", href: "/settings?tab=account" },
  NONE: null,
};

export function deliveryFixTarget(link: string): { label: string; href: string } | null {
  return Object.prototype.hasOwnProperty.call(DELIVERY_FIX_TARGET, link)
    ? DELIVERY_FIX_TARGET[link as DeliveryFixLink]
    : null;
}

// ─── Recurring invoice run failures ──────────────────────────────────────────

const RUN_SUSPENDED = "Suspended:";

/**
 * A recurring invoice's `lastError` is free text from the API (an exception message). It is never
 * shown: known prefixes map to a fixed sentence, everything else to a generic one. `retryable`
 * mirrors `isRetryableRunFailure` (REG-B106): an unfinalized cycle is already billed, so no re-run.
 */
export function describeRunFailure(lastError: string): { text: string; retryable: boolean } {
  if (lastError.startsWith(RUN_UNFINALIZED_PREFIX)) {
    return {
      text: "The invoice was created, but the run couldn't be finalized. Don't run it again.",
      retryable: false,
    };
  }
  if (lastError.startsWith(RUN_SUSPENDED)) {
    // The restricted product lines are tenant data (not provider text): keep naming them.
    // Names may themselves contain parentheses ("Soda (12 oz)"), so stop at the ")." that ends the list.
    const names = lastError.match(/selling restriction \((.*?)\)\. /)?.[1];
    return {
      text: `Paused because a line is under a selling restriction${names ? ` (${names})` : ""}. Fix the template and reactivate it; the skipped cycle isn't billed.`,
      retryable: true,
    };
  }
  return { text: "The last run failed. Use Run Now to retry.", retryable: true };
}

// ─── Return reasons (realtime toast) ─────────────────────────────────────────

const RETURN_REASON_COPY: Record<string, string> = {
  DAMAGED: "Damaged",
  WRONG_ITEM: "Wrong item",
  CUSTOMER_REFUSED: "Customer refused",
  QUALITY_ISSUE: "Quality issue",
  EXCESS_ORDER: "Excess order",
};

export function describeReturnReason(reason: string): string {
  return Object.prototype.hasOwnProperty.call(RETURN_REASON_COPY, reason)
    ? RETURN_REASON_COPY[reason]
    : "No reason given";
}

/**
 * The reason options of a return form, by where the goods came from. The VALUES are the Prisma `ReturnReason` enum (no
 * enum change, L-072); only the words differ: a delivery return keeps the delivery words, a counter sale says what
 * happened at the register.
 */
export type ReturnReasonContext = "delivery" | "counter";

const RETURN_REASON_OPTION_LABEL: Record<
  ReturnReasonContext,
  ReadonlyArray<[ReturnReason, string]>
> = {
  delivery: [
    ["DAMAGED", "Damaged"],
    ["WRONG_ITEM", "Wrong Item"],
    ["CUSTOMER_REFUSED", "Customer Refused"],
    ["QUALITY_ISSUE", "Quality Issue"],
    ["EXCESS_ORDER", "Excess / Overdelivery"],
  ],
  counter: [
    ["DAMAGED", "Damaged"],
    ["WRONG_ITEM", "Wrong item"],
    ["CUSTOMER_REFUSED", "Changed their mind"],
    ["QUALITY_ISSUE", "Faulty"],
    ["EXCESS_ORDER", "Bought too many"],
  ],
};

export function returnReasonOptions(
  context: ReturnReasonContext,
): Array<{ value: ReturnReason; label: string }> {
  return RETURN_REASON_OPTION_LABEL[context].map(([value, label]) => ({ value, label }));
}

// ─── Save errors (mutations) ─────────────────────────────────────────────────

/** Maps an axios-style error to a fixed sentence by HTTP status; never echoes `message`. */
export function describeSaveError(err: unknown): string {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 409) return "That username or email is already in use.";
  if (status === 400) {
    // users.service.ts answers a duplicate with 400 + "Email/Username already in use". The server
    // text only CLASSIFIES here; it is never displayed.
    const serverText = String(
      (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message ?? "",
    );
    if (/email already in use/i.test(serverText)) return "That email is already in use.";
    if (/username already in use/i.test(serverText)) return "That username is already in use.";
  }
  if (status === 400 || status === 422) return "Check the details and try again.";
  if (status === 403 && isReadOnlyRefusal(err)) return readOnlyRefusalCopy();
  if (status === 403) return "You don't have permission to do that.";
  return "Couldn't save, please try again.";
}

// ─── Scan modal ──────────────────────────────────────────────────────────────

export const SCAN_FAILED_COPY = "We couldn't read this page. Try a clearer photo.";
export const RECORDS_FAILED_COPY = "We couldn't create the records. Please try again.";
