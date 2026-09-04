/**
 * Single source of truth for payment-method lists in the mobile app.
 * Mirrors the Prisma `PaymentMethod` enum (apps/api/prisma/schema/finance.prisma) and
 * apps/web/lib/payment-methods.ts — keep the three in sync.
 *
 * CREDIT_NOTE and ADVANCE are system-written (the dedicated Apply Credit Note /
 * Apply Advance actions create them; POST /invoices/:id/payments rejects them),
 * so they are never user-selectable — they exist only for display.
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
  ACH: "ACH",
  CREDIT_CARD: "Credit card",
  OTHER: "Other",
  CREDIT_NOTE: "Credit note",
  ADVANCE: "Advance",
};

/** Chip list for payment-entry screens: { id, label } per selectable method. */
export const SELECTABLE_METHOD_OPTIONS = SELECTABLE_PAYMENT_METHODS.map((id) => ({
  id,
  label: PAYMENT_METHOD_LABELS[id],
}));

export const paymentMethodLabel = (method: string): string =>
  PAYMENT_METHOD_LABELS[method as AnyPaymentMethod] ?? method;
