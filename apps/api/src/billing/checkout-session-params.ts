import { Logger } from "@nestjs/common";
import type Stripe from "stripe";

/**
 * The ONE place a platform Checkout Session's tax / Managed Payments policy is applied (owner ruling
 * 2026-10-06: no tax on subscriptions; Stripe Managed Payments OFF).
 *
 * Why it must be explicit: on an account where Managed Payments is on by default, a create that says nothing
 * is treated as a Managed Payments session, which then demands a product tax code and fails (503 on the
 * catch-up checkout). Sending `managed_payments: { enabled: false }` opts the session out, whatever the
 * account default is. `SessionCreateParams.managed_payments` is typed by the pinned SDK (stripe ^22.6.2,
 * API `2026-08-26.dahlia`), so no type extension is needed.
 *
 * Every `checkout.sessions.create(` in `apps/api/src` passes its params through {@link withCheckoutPolicy};
 * `checkout-session-policy.pin.spec.ts` fails the build if one does not.
 *
 * SA-1037 r3 PR-1: the same chokepoint carries the ops switch for WHICH payment methods a platform session offers
 * ({@link checkoutPaymentMethodTypes}, env `BILLING_CHECKOUT_PAYMENT_METHODS`). Unset is today: the field is omitted
 * and the Stripe Dashboard decides.
 */

const logger = new Logger("CheckoutPolicy");

/** The one env var behind the payment-method switch (house shape of `BILLING_PAUSE_MODE`: an ops switch, one reader). */
export const CHECKOUT_PAYMENT_METHODS_ENV = "BILLING_CHECKOUT_PAYMENT_METHODS";

/** The accepted values and the `payment_method_types` each one sends. Anything else is treated as unset. */
const PAYMENT_METHOD_SETS = {
  card_and_bank: ["card", "us_bank_account"],
} as const satisfies Record<
  string,
  readonly Stripe.Checkout.SessionCreateParams.PaymentMethodType[]
>;

const warnedUnknown = new Set<string>();

/**
 * `payment_method_types` for a platform Checkout Session, from env `BILLING_CHECKOUT_PAYMENT_METHODS`:
 * unset, empty or unknown -> `undefined` (the field is omitted, so the Dashboard decides, as today; an unknown value
 * logs one warning per value); `card_and_bank` -> `["card", "us_bank_account"]`. A typo can never narrow what a tenant
 * is offered. Ops sets the env only after the Dashboard side is ready (SA-1037 r3 ruling 1).
 */
export function checkoutPaymentMethodTypes(
  env: Record<string, string | undefined> = process.env,
): Stripe.Checkout.SessionCreateParams.PaymentMethodType[] | undefined {
  const raw = (env[CHECKOUT_PAYMENT_METHODS_ENV] ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  if (Object.prototype.hasOwnProperty.call(PAYMENT_METHOD_SETS, raw)) {
    return [...PAYMENT_METHOD_SETS[raw as keyof typeof PAYMENT_METHOD_SETS]];
  }
  if (!warnedUnknown.has(raw)) {
    warnedUnknown.add(raw);
    logger.warn(
      `${CHECKOUT_PAYMENT_METHODS_ENV}="${raw}" is not a known value (card_and_bank); the payment methods are left to the Dashboard`,
    );
  }
  return undefined;
}

/** Thrown when a caller asks for what the owner ruling forbids (automatic tax or Managed Payments on). */
export class CheckoutPolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutPolicyViolation";
  }
}

export type WithCheckoutPolicy<T> = T & { managed_payments: { enabled: false } };

/**
 * Returns `params` with `managed_payments: { enabled: false }` set (idempotent), every other key untouched, plus
 * `payment_method_types` from {@link checkoutPaymentMethodTypes} when the env names a set and the caller did not name its own.
 * Throws {@link CheckoutPolicyViolation} when the caller passed `automatic_tax.enabled: true` or
 * `managed_payments.enabled: true` - a silent rewrite would hide a policy change from review.
 */
export function withCheckoutPolicy<T extends Stripe.Checkout.SessionCreateParams>(
  params: T,
): WithCheckoutPolicy<T> {
  if (params.automatic_tax?.enabled === true) {
    throw new CheckoutPolicyViolation(
      "automatic_tax.enabled=true is not allowed on a Checkout Session (owner ruling: no tax on subscriptions)",
    );
  }
  if (params.managed_payments?.enabled === true) {
    throw new CheckoutPolicyViolation(
      "managed_payments.enabled=true is not allowed on a Checkout Session (owner ruling: Managed Payments off)",
    );
  }
  const paymentMethodTypes = params.payment_method_types ?? checkoutPaymentMethodTypes();
  return {
    ...params,
    ...(paymentMethodTypes ? { payment_method_types: paymentMethodTypes } : {}),
    managed_payments: { ...params.managed_payments, enabled: false as const },
  };
}
