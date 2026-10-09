/**
 * Allow-list of `EmailDelivery.kind` template keys (app-level, no enum churn — see the
 * EmailDelivery model). `EmailService.send({ delivery })` and the WS4 staff-order emails pass one.
 */
export const EMAIL_KINDS = [
  "STAFF_NEW_ORDER",
  "BUYER_ORDER_EDITED",
  "BUYER_ORDER_CANCELLED",
  "LOW_STOCK_DIGEST",
  "INVOICE_SENT",
  "AUTH_OTHER",
  "Z_REPORT",
] as const;

export type EmailKind = (typeof EMAIL_KINDS)[number];
