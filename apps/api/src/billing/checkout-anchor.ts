import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BOUNDARY_HOUR_UTC, nextBoundaryAfter } from "./rf-invoice/calendar-windows";

/**
 * SA-733 D6 / SA-733r [M6]: the billing anchor of a NEW Checkout subscription.
 *
 * Every new subscription is anchored to the 1st of a month at 12:00 UTC (noon keeps the charge on the 1st in
 * every US zone) with `proration_behavior: create_prorations`, so the customer pays the prorated stub up to that
 * 1st at checkout and the full fee on it. The anchor is ALWAYS explicit (the 1st no longer omits it).
 *
 * Pure: no Stripe, no database, no clock of its own (`now` is a parameter).
 *
 * Verified against Stripe's Checkout docs ("Set the billing cycle date"): `subscription_data.billing_cycle_anchor`
 * must be a future timestamp within the first billing period, and a customer who pays AFTER the anchor is charged
 * the full period starting at the anchor instead of the prorated stub - which is why the session must expire
 * before the anchor (`expires_at`, below). This shape carries recurring lines only: Checkout rejects a one-time
 * price beside `proration_behavior: none`, and the catch-up (catchup-plan.ts, SA-733r5) never pairs a one-time line
 * with `proration_behavior` at all.
 */

/** The anchor's wall-clock hour (UTC) on the 1st: the SAME boundary every billing window uses. */
export const ANCHOR_HOUR_UTC = BOUNDARY_HOUR_UTC;

/** An anchor closer than this to "now" is REFUSED (F3): the checkout reopens just after the 1st. */
export const MIN_ANCHOR_LEAD_MS = 91 * 60 * 1000;

/** The session must expire at least this long before the anchor, so it can never complete after it (M6). */
export const CHECKOUT_EXPIRY_MARGIN_MS = 60 * 60 * 1000;

/** Stripe's own ceiling on a Checkout Session's lifetime (and our default). */
export const CHECKOUT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface CheckoutAnchorPlan {
  /** The anchor instant (the 1st, 12:00 UTC). */
  anchorAt: Date;
  /** `subscription_data.billing_cycle_anchor` - epoch SECONDS. */
  billingCycleAnchor: number;
  /** The Checkout session `expires_at` - epoch SECONDS: min(now + 24 h, anchor - 60 min). */
  expiresAt: number;
  prorationBehavior: "create_prorations";
}

/**
 * The anchor for a checkout created at `now`: the next 1st at 12:00 UTC. Never skipped to the FOLLOWING 1st
 * (F3): that is a month and more away, and Stripe requires the anchor within the first billing period.
 * Callers that must keep the lead use {@link planCheckoutAnchor}, which refuses a start too close to it.
 */
export function nextCheckoutAnchor(now: Date): Date {
  return nextBoundaryAfter(now);
}

/**
 * Everything a new-subscription Checkout session needs for its anchor, from `now`. F3: a start under
 * {@link MIN_ANCHOR_LEAD_MS} (91 minutes: Stripe's 30-minute floor on `expires_at`, the 60-minute margin and a
 * minute of rounding) before the 1st is REFUSED with a 409 `CHECKOUT_ANCHOR_WINDOW` carrying `retryAt` (the 1st
 * plus one minute), the earliest instant the next anchor is a valid one. No stub, no dropped anchor.
 */
export function planCheckoutAnchor(now: Date): CheckoutAnchorPlan {
  const boundary = nextBoundaryAfter(now);
  if (boundary.getTime() - now.getTime() < MIN_ANCHOR_LEAD_MS) {
    throw new ConflictException({
      code: API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW,
      message: "Checkout is paused around the start of the month.",
      retryAt: new Date(boundary.getTime() + 60_000).toISOString(),
    });
  }
  const anchorAt = nextCheckoutAnchor(now);
  const expiresMs = Math.min(
    now.getTime() + CHECKOUT_MAX_LIFETIME_MS,
    anchorAt.getTime() - CHECKOUT_EXPIRY_MARGIN_MS,
  );
  return {
    anchorAt,
    billingCycleAnchor: Math.floor(anchorAt.getTime() / 1000),
    // Stripe floors fractions; round DOWN so the session never outlives the margin.
    expiresAt: Math.floor(expiresMs / 1000),
    prorationBehavior: "create_prorations",
  };
}

/** The `subscription_data` fragment (anchor + proration) merged into a new-subscription session. */
export function checkoutAnchorParams(plan: CheckoutAnchorPlan): {
  billing_cycle_anchor: number;
  proration_behavior: "create_prorations";
} {
  return {
    billing_cycle_anchor: plan.billingCycleAnchor,
    proration_behavior: plan.prorationBehavior,
  };
}
