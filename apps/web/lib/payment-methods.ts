/**
 * Single source of truth for payment-method lists in the web app.
 * The method SET is the shared `PaymentMethod` from @routeflow/types (#2722).
 *
 * CREDIT_NOTE and ADVANCE are system-written (the dedicated Apply Credit Note /
 * Apply Advance actions create them; POST /invoices/:id/payments rejects them),
 * so they are never user-selectable — they exist only for display and filtering.
 */
import type { PaymentMethod } from "@routeflow/types";

/** #2722: the method set is the shared `PaymentMethod` (packages/types/api/enums.ts, pinned to
 *  Prisma by enum-parity.spec.ts). Only the ORDER and the labels are local. */
export type AnyPaymentMethod = PaymentMethod;

/** System-written methods (never user-selectable). */
type SystemPaymentMethod = Extract<PaymentMethod, "CREDIT_NOTE" | "ADVANCE">;
export type SelectablePaymentMethod = Exclude<PaymentMethod, SystemPaymentMethod>;

/** Display order of the user-selectable methods (a local choice, typed by the shared enum). */
export const SELECTABLE_PAYMENT_METHODS = [
  "CASH",
  "CHECK",
  "ZELLE",
  "ACH",
  "CREDIT_CARD",
  "OTHER",
] as const satisfies readonly SelectablePaymentMethod[];

export const ALL_PAYMENT_METHODS = [
  ...SELECTABLE_PAYMENT_METHODS,
  "CREDIT_NOTE",
  "ADVANCE",
] as const satisfies readonly PaymentMethod[];

// Compile-time: ALL_PAYMENT_METHODS lists EVERY shared PaymentMethod (a new enum value breaks the build).
type MissingPaymentMethod = Exclude<PaymentMethod, (typeof ALL_PAYMENT_METHODS)[number]>;
const allMethodsListed: [MissingPaymentMethod] extends [never] ? true : never = true;
void allMethodsListed;

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
