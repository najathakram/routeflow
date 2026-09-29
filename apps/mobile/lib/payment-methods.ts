/**
 * Single source of truth for payment-method lists in the mobile app.
 * The method SET is the shared `PaymentMethod` from @routeflow/types (#2722); the order and the
 * labels below are this app's own.
 *
 * CREDIT_NOTE and ADVANCE are system-written (the dedicated Apply Credit Note /
 * Apply Advance actions create them; POST /invoices/:id/payments rejects them),
 * so they are never user-selectable — they exist only for display.
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
