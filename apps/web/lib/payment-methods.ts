/**
 * Single source of truth for payment-method lists in the web app.
 * Mirrors the Prisma `PaymentMethod` enum (apps/api/prisma/schema/finance.prisma).
 *
 * CREDIT_NOTE and ADVANCE are system-written (the dedicated Apply Credit Note /
 * Apply Advance actions create them; POST /invoices/:id/payments rejects them),
 * so they are never user-selectable — they exist only for display and filtering.
 */
export const SELECTABLE_PAYMENT_METHODS = [
  "CASH",
  "CHECK",
  "ZELLE",
  "ACH",
  "CREDIT_CARD",
  "OTHER",
] as const;

export type SelectablePaymentMethod = (typeof SELECTABLE_PAYMENT_METHODS)[number];

export const ALL_PAYMENT_METHODS = [
  ...SELECTABLE_PAYMENT_METHODS,
  "CREDIT_NOTE",
  "ADVANCE",
] as const;

export type AnyPaymentMethod = (typeof ALL_PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<AnyPaymentMethod, string> = {
  CASH: "Cash",
  CHECK: "Check",
  ZELLE: "Zelle",
  ACH: "ACH / Bank Transfer",
  CREDIT_CARD: "Credit Card",
  OTHER: "Other",
  CREDIT_NOTE: "Credit Note",
  ADVANCE: "Advance",
};

export const PAYMENT_METHOD_COLORS: Record<AnyPaymentMethod, string> = {
  CASH: "bg-success-bg text-success",
  CHECK: "bg-brand-50 text-brand-600",
  ZELLE: "bg-violet-50 text-violet-700",
  ACH: "bg-indigo-50 text-indigo-700",
  CREDIT_CARD: "bg-orange-50 text-orange-700",
  OTHER: "bg-surface-raised text-navy/70",
  CREDIT_NOTE: "bg-purple-100 text-purple-800",
  ADVANCE: "bg-teal-50 text-teal-700",
};

export const paymentMethodLabel = (method: string): string =>
  PAYMENT_METHOD_LABELS[method as AnyPaymentMethod] ?? method;
