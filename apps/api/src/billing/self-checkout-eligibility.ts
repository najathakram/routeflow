import type { SelfPayReason, SelfPayView } from "@routeflow/types";
import { READ_ONLY_STATUS, paymentReinstatable } from "./dunning-config";
import { isPayingRow } from "./mrr.service";
import { LIVE_PAYMENTS_CLASS, livePaymentsAllowed, type StripeKeyMode } from "./live-payments-wall";
import {
  INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT,
  isInviteOnlyPlanKey,
} from "./plan-catalog.constants";
import { seesBillingMoney } from "./subscription-billing-extras";

/**
 * SA-1547 PR-3 (ruling 2026-11-26, section 2): WHO IS OFFERED "Pay now" - the one pure helper every surface and the
 * checkout route read. It returns a coded reason, never a bare boolean.
 *
 * Live: an invited LITE business that is not ACTIVE (today's behaviour), and a trial-expired READ_ONLY business
 * (`trial_expired`, `trial_cancelled`). Not live: a TRIAL with days left (B1, owner-final 2026-11-24), ACTIVE with no card
 * (until owner box Q4), a dunning READ_ONLY (keeps the Pay invoice strip), externalPayment (keeps the catch-up banner),
 * a full coupon, a $0 or unpriceable plan.
 *
 * Built from `paymentReinstatable`, `externalPayment`, "no Stripe subscription", `linkPending`, `isPayingRow` and a server
 * price above 0. No I/O and no clock: the caller reads the facts.
 */

/** B1 (owner-final 2026-11-24, not re-asked): no self-pay while a trial has days left. Removed when the owner rules again. */
export const SELF_PAY_DURING_TRIAL: boolean = false;

/** Every reason, as a runtime list: the `Record` makes a reason added to the shared union fail to compile until it is named here. */
const REASON_SET: Record<SelfPayReason, true> = {
  trial_expired: true,
  lite_payment_due: true,
  trial_active: true,
  active_no_card: true,
  not_self_pay_state: true,
  not_reinstatable: true,
  external_payment: true,
  live_subscription: true,
  link_pending: true,
  not_paying_row: true,
  live_payments_off: true,
  coupon_full: true,
  no_price: true,
  not_admin: true,
  support_session: true,
  unavailable: true,
};
export const SELF_PAY_REASONS = Object.keys(REASON_SET) as SelfPayReason[];

export interface SelfCheckoutFacts {
  status: string;
  readOnlyReason: string | null;
  /** The tenant's class: judged by the live-payments wall's own predicate (never a second copy of the rule). */
  class: string | null;
  /** The Stripe key mode the wall reads (a test key opens every class); defaults to the configured key. */
  keyMode?: StripeKeyMode;
  /** `deletedAt`: `isPayingRow` reads it. */
  deletedAt: Date | null;
  planKey: string | null;
  /** The stored Stripe subscription id (a stale id fails closed: no Pay now; the checkout re-reads Stripe itself). */
  stripeSubId: string | null;
  externalPayment: boolean;
  /** The subscription is billed $0 by a full coupon (`TenantSubscription.couponFull`): unbilled, never paying. */
  couponCoversAll: boolean;
  /** `isLinkPending`: a card or bank payment is still clearing. */
  linkPending: boolean;
  /** The server price (the quoted fee, else the catalog): null when it cannot be priced. */
  monthly: number | null;
}

export interface SelfCheckoutVerdict {
  eligible: boolean;
  reason: SelfPayReason;
}

const no = (reason: SelfPayReason): SelfCheckoutVerdict => ({ eligible: false, reason });
const yes = (reason: SelfPayReason): SelfCheckoutVerdict => ({ eligible: true, reason });

/** A trial lock a payment lifts into a paid plan (`trial_expired`, `trial_cancelled`). */
const isTrialLock = (status: string, reason: string | null) =>
  status === READ_ONLY_STATUS && (reason === "trial_expired" || reason === "trial_cancelled");

export function selfCheckoutEligibility(f: SelfCheckoutFacts): SelfCheckoutVerdict {
  // A lock an admin set (or any state a payment may not lift) never takes money we cannot honour (SA-832).
  if (!paymentReinstatable(f.status, f.readOnlyReason)) return no("not_reinstatable");
  if (f.externalPayment) return no("external_payment");
  if (f.linkPending) return no("link_pending");
  if (f.stripeSubId) return no("live_subscription");
  // The class is the wall's call (ruling 7203127751 item 1): never offer Pay now where the wall would refuse the session.
  if (!livePaymentsAllowed(f.class, f.keyMode)) return no("live_payments_off");
  // `isPayingRow` also wants status ACTIVE, which is what the payment will make it, and a PRODUCTION class, which the
  // wall has just judged: judge the other conditions (deleted, plan, full coupon).
  if (
    !isPayingRow(
      { status: "ACTIVE", deletedAt: f.deletedAt, class: LIVE_PAYMENTS_CLASS },
      f.planKey,
      f.couponCoversAll,
    )
  ) {
    return no(f.couponCoversAll ? "coupon_full" : "not_paying_row");
  }
  if (f.monthly == null || !(f.monthly > 0)) return no("no_price");

  // An invited LITE business has no trial: it pays whenever it is not ACTIVE (today's `paymentRequired`).
  if (isInviteOnlyPlanKey(f.planKey) && f.status !== "ACTIVE") {
    return INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT
      ? yes("lite_payment_due")
      : no("not_self_pay_state");
  }
  if (f.status === "TRIAL") return { eligible: SELF_PAY_DURING_TRIAL, reason: "trial_active" };
  if (isTrialLock(f.status, f.readOnlyReason)) return yes("trial_expired");
  if (f.status === "ACTIVE") return no("active_no_card");
  return no("not_self_pay_state");
}

/**
 * What one VIEWER may see of the verdict: only a workspace admin is offered Pay now, and never from a support session
 * (the route is `@NoImpersonation("billing")`, so the button is hidden rather than left to fail with a 403). The plan,
 * price and anchor stay: they are the business's own figures and an operator already reads the plan.
 */
export function selfPayForViewer<T extends SelfPayView<unknown>>(
  view: T,
  viewer: { role: string | null | undefined; impersonated: boolean },
): T {
  if (!view.eligible) return view;
  if (viewer.impersonated) return { ...view, eligible: false, reason: "support_session" };
  if (!seesBillingMoney(viewer.role)) return { ...view, eligible: false, reason: "not_admin" };
  return view;
}
