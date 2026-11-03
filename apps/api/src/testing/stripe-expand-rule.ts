/**
 * Stripe's `expand` rule, as a spec helper: "You cannot expand more than 4 levels of a property."
 *
 * Measured against Stripe test mode (API 2026-08-26.dahlia): `latest_invoice.payments.data.payment.payment_intent`
 * (5 levels) is refused on `subscriptions.retrieve`; `latest_invoice.payments` (2) and, on `invoices.retrieve`,
 * `payments.data.payment.payment_intent` (4) are accepted. A level is one dot-separated segment, `data` included.
 *
 * A mock that accepts any `expand` is how a 5-level path shipped green. Specs that fake a Stripe retrieve pass the
 * request's `expand` through {@link assertStripeExpandable} so the fake refuses what Stripe refuses.
 */
export const STRIPE_MAX_EXPAND_LEVELS = 4;

export function stripeExpandLevels(path: string): number {
  return path.split(".").length;
}

/** Throws a Stripe-shaped error for the first path deeper than Stripe allows; otherwise returns. */
export function assertStripeExpandable(expand: readonly string[] | undefined): void {
  for (const path of expand ?? []) {
    if (stripeExpandLevels(path) > STRIPE_MAX_EXPAND_LEVELS) {
      throw Object.assign(
        new Error(
          `You cannot expand more than ${STRIPE_MAX_EXPAND_LEVELS} levels of a property. Property: ${path}`,
        ),
        { type: "StripeInvalidRequestError", statusCode: 400 },
      );
    }
  }
}
