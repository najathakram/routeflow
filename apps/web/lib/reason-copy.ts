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
