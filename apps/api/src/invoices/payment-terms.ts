// ─── Invoice payment terms: the API literal (W-1487) ─────────────────────────────────────────────────
//
// A literal duplicate of packages/types/payment-terms.ts: the API never value-imports @routeflow/types (L-261), so
// payment-terms-parity.spec.ts pins this file to the shared one (every preset and custom labels). Edit BOTH or the spec
// goes red. Terms are stored as text ("Net 30"): no migration. Also home of the DTO check for a customer / tenant
// default-terms field, so a typed "Net 21" is accepted where it used to be refused.

import { registerDecorator, type ValidationOptions } from "class-validator";

export const PAYMENT_TERM_PRESETS = [
  "Due on Receipt",
  "Net 7",
  "Net 15",
  "Net 30",
  "Net 45",
  "Net 60",
  "Net 90",
] as const;
export type PaymentTermPreset = (typeof PAYMENT_TERM_PRESETS)[number];

export const PAYMENT_TERM_MIN_DAYS = 1;
export const PAYMENT_TERM_MAX_DAYS = 365;

/** "Due on Receipt" is 0, "Net N" is N for a whole N from 1 to 365, anything else is null. */
export function termDays(label: string | null | undefined): number | null {
  if (typeof label !== "string") return null;
  const text = label.trim();
  if (text === "Due on Receipt") return 0;
  const m = /^Net ([1-9]\d{0,2})$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= PAYMENT_TERM_MIN_DAYS && n <= PAYMENT_TERM_MAX_DAYS ? n : null;
}

/** The label stored for a custom term; null when `n` is not a whole number of days in range. */
export function netLabel(n: number): string | null {
  return Number.isInteger(n) && n >= PAYMENT_TERM_MIN_DAYS && n <= PAYMENT_TERM_MAX_DAYS
    ? `Net ${n}`
    : null;
}

/** `@IsPaymentTerm()`: a preset or a custom "Net N" (1-365). `allowEmpty` also accepts "" (clear the override). */
export function IsPaymentTerm(
  options: { allowEmpty?: boolean } = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) =>
    registerDecorator({
      name: "isPaymentTerm",
      target: object.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} must be one of: ${PAYMENT_TERM_PRESETS.join(", ")}, or Net N (a whole number of days from ${PAYMENT_TERM_MIN_DAYS} to ${PAYMENT_TERM_MAX_DAYS})${options.allowEmpty ? ", or empty" : ""}`,
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === "string" &&
          (termDays(value) !== null || (!!options.allowEmpty && value === "")),
      },
    });
}
