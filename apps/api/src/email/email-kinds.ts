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
  "RECEIPT",
  "PAYMENT_FAILED",
] as const;

export type EmailKind = (typeof EMAIL_KINDS)[number];

/**
 * Who a delivery row of this kind is FOR. `tenant`: the tenant's own mail (staff alerts, their customers' receipts) - it
 * shows in the tenant's delivery log and health strip. `platform`: RouteFlow-to-tenant mail (billing) - it is recorded for
 * the platform (dedupe, audit) but never shown to the tenant, whose health strip would otherwise blame a platform
 * send failure on the tenant's own e-mail settings. The exhaustive Record makes a new kind declare its audience at
 * compile time; the tenant delivery list and health strip filter on PLATFORM_AUDIENCE_KINDS, never on a named kind.
 */
export type EmailAudience = "tenant" | "platform";
export const EMAIL_KIND_AUDIENCE: Record<EmailKind, EmailAudience> = {
  STAFF_NEW_ORDER: "tenant",
  BUYER_ORDER_EDITED: "tenant",
  BUYER_ORDER_CANCELLED: "tenant",
  LOW_STOCK_DIGEST: "tenant",
  INVOICE_SENT: "tenant",
  AUTH_OTHER: "tenant",
  Z_REPORT: "tenant",
  RECEIPT: "tenant",
  PAYMENT_FAILED: "platform",
};
export const PLATFORM_AUDIENCE_KINDS: readonly EmailKind[] = EMAIL_KINDS.filter(
  (k) => EMAIL_KIND_AUDIENCE[k] === "platform",
);
