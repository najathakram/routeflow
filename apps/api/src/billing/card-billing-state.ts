import {
  READ_ONLY_STATUS,
  STRIPE_CANCELLED_REASON,
  SUBSCRIPTION_CANCELLED_REASON,
} from "./dunning-config";

/**
 * SA-1545 C2.1: what the STORED fields can say about a business's card billing. No Stripe status is stored, so the
 * stored fields can never say whether Stripe will bill; they can say only that nothing exists (`none`), that the five
 * clauses below hold (`live`, the stored approximation), or that a Stripe link exists and is not provably billing
 * (`uncertain`). Pure, no I/O, no Stripe call. `live` never relaxes a guard by itself: it only drives the list badge
 * (billed_not_production) and, later, the not-configured fallback of the class-change guard.
 *
 * `none` is sound: every checkout session needs a stored customer first (ensureStripeCustomer upserts the id), no writer
 * sets stripeCustomerId null, and a catch-up claim stores catchupState.
 *
 * Local list and type (the `import type` rule): the API never value-imports `@routeflow/types`.
 */
export const CARD_BILLING_STATE_VALUES = ["none", "live", "uncertain"] as const;
export type CardBillingState = (typeof CARD_BILLING_STATE_VALUES)[number];

export function cardBillingState(
  tenant: { status: string; deletedAt: Date | null; readOnlyReason?: string | null },
  sub: {
    stripeSubId: string | null;
    stripeCustomerId: string | null;
    catchupState: string | null;
    cancelAtPeriodEnd: boolean;
  } | null,
): CardBillingState {
  if (sub == null) return "none";
  if (sub.stripeSubId == null && !sub.stripeCustomerId && sub.catchupState == null) return "none";
  const live =
    sub.stripeSubId != null &&
    sub.cancelAtPeriodEnd === false &&
    tenant.deletedAt == null &&
    tenant.status !== "CANCELLED" &&
    !(
      tenant.status === READ_ONLY_STATUS &&
      (tenant.readOnlyReason === SUBSCRIPTION_CANCELLED_REASON ||
        tenant.readOnlyReason === STRIPE_CANCELLED_REASON)
    );
  return live ? "live" : "uncertain";
}
