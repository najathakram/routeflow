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

const DELIVERY_REASON_COPY: Record<DeliveryReasonCode, string> = {
  RULE_OFF: "Skipped because this notification is switched off.",
  NO_RECIPIENT: "Skipped because the customer has no email address.",
  OPTED_OUT: "Skipped because the recipient opted out.",
  NO_FROM_ADDRESS: "Not sent because no sending email address is set up.",
  MAILBOX_REVOKED: "Not sent because the connected mailbox lost access. Reconnect it.",
  SMTP_AUTH: "Not sent because the email account sign-in was rejected.",
  TRANSPORT_ERROR: "Not sent because of an email delivery problem.",
  RECIPIENT_REJECTED: "Not sent because the recipient's mail server rejected the message.",
  UNKNOWN: GENERIC,
};

export function describeDeliveryReason(code: string): string {
  return Object.prototype.hasOwnProperty.call(DELIVERY_REASON_COPY, code)
    ? DELIVERY_REASON_COPY[code as DeliveryReasonCode]
    : GENERIC;
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
