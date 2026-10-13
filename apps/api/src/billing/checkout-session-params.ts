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
 */

/** Thrown when a caller asks for what the owner ruling forbids (automatic tax or Managed Payments on). */
export class CheckoutPolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutPolicyViolation";
  }
}

export type WithCheckoutPolicy<T> = T & { managed_payments: { enabled: false } };

/**
 * Returns `params` with `managed_payments: { enabled: false }` set (idempotent), every other key untouched.
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
  return { ...params, managed_payments: { ...params.managed_payments, enabled: false as const } };
}
