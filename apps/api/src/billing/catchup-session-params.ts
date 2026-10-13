import { CATCHUP_META } from "./catchup-claim";
import { planCheckoutAnchor } from "./checkout-anchor";
import {
  CATCHUP_TRIAL_MIN_LEAD_MS,
  CATCHUP_TRIAL_STUB_MIN_LEAD_MS,
  STRIPE_MIN_CHARGE_CENTS,
  type CatchupPlan,
} from "./catchup-plan";

/**
 * The Stripe Checkout parameters of a catch-up session - a PURE function of the plan, ONE builder per shape
 * (SA-733r5). Only shapes Stripe's Checkout documentation allows are built (docs.stripe.com/payments/checkout/
 * billing-cycle, "Limitations"; docs.stripe.com/billing/subscriptions/trials/free-trials):
 *
 *   trial_one_time `subscription_data.trial_end = A` alone (A = the first 1st at 12:00Z >= now + 72 h; no explicit
 *                  billing_cycle_anchor - the anchor follows the trial end - and no proration_behavior), the
 *                  recurring lines, and ONE one-time line = the unpaid [paid-through, A) (base + add-ons, prorated).
 *                  Stripe charges the one-time line at completion; the recurring cycle starts at A. Documented:
 *                  trials combine with one-time prices - the one-time amount is invoiced up front.
 *   trial          prepaid (R16-3): `trial_end = T` alone, recurring lines only; the stub is a post-completion draft
 *                  invoice (catchup-claim.service).
 *   anchor_no_line prepaid with T under 72 h away: `billing_cycle_anchor` + `proration_behavior: none`, recurring
 *                  lines only (a one-time line beside `none` is rejected by Checkout).
 *
 * {@link assertCheckoutAcceptable} is the structural pin (R5-4) that no built params ever pair a one-time line with
 * `proration_behavior`, nor `trial_end` with `billing_cycle_anchor`; it runs on everything returned here. There is
 * no `invoiceItems.create` fallback anywhere.
 */

export interface CatchupSessionInput {
  tenantId: string;
  slug: string;
  planKey: string;
  customerId: string;
  /** The tenant's monthly plan line: checkoutPriceData(tenant, "month"). */
  planPriceData: Record<string, any>;
  /** The recurring add-on lines (checkoutAddonLines). */
  addonLines: { price_data: Record<string, any>; quantity: number }[];
  addonSkus: string[];
  plan: CatchupPlan;
  now: Date;
  successUrl: string;
  cancelUrl: string;
}

const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const DAY_MS = 24 * 60 * 60 * 1000;

/** R5-4. Throws on a combination Checkout rejects. */
export function assertCheckoutAcceptable(params: {
  line_items?: { price_data?: { recurring?: unknown } }[];
  subscription_data?: Record<string, unknown>;
}): void {
  const sd = params.subscription_data ?? {};
  const hasTrial = sd.trial_end != null || sd.trial_period_days != null;
  if (hasTrial && sd.billing_cycle_anchor != null) {
    throw new Error("Checkout rejects a trial combined with billing_cycle_anchor");
  }
  const oneTime = (params.line_items ?? []).some((l) => !l.price_data?.recurring);
  if (oneTime && sd.proration_behavior != null) {
    throw new Error("a one-time line must not be paired with proration_behavior");
  }
}

function common(i: CatchupSessionInput) {
  const subMetaBase = {
    tenantId: i.tenantId,
    ...(i.addonSkus.length ? { addonSkus: i.addonSkus.join(",") } : {}),
  };
  return {
    subMetaBase,
    sessionBase: {
      customer: i.customerId,
      mode: "subscription",
      success_url: i.successUrl,
      cancel_url: i.cancelUrl,
    },
    metaBase: {
      tenantId: i.tenantId,
      slug: i.slug,
      planKey: i.planKey,
      interval: "month",
      ...(i.addonSkus.length ? { addonSkus: i.addonSkus.join(",") } : {}),
    },
    recurring: [{ price_data: i.planPriceData, quantity: 1 }, ...i.addonLines],
  };
}

/** trial_one_time: the common case (an unpaid period). */
function buildTrialOneTime(i: CatchupSessionInput): Record<string, any> {
  const { plan } = i;
  const c = common(i);
  const stubCents = plan.stub.totalCents >= STRIPE_MIN_CHARGE_CENTS ? plan.stub.totalCents : 0;
  const oneTime = stubCents
    ? [
        {
          price_data: {
            currency: "usd",
            unit_amount: stubCents,
            product_data: { name: plan.stub.label },
          },
          quantity: 1,
        },
      ]
    : [];
  const span = {
    [CATCHUP_META.from]: plan.stub.from.toISOString(),
    [CATCHUP_META.to]: plan.stub.to.toISOString(),
  };
  return {
    ...c.sessionBase,
    payment_method_collection: "always",
    line_items: [...c.recurring, ...oneTime],
    // A >= now + 72 h, so this is now + 24 h (min() kept for the contract: never past A - 60 min)
    expires_at: epoch(
      new Date(Math.min(i.now.getTime() + DAY_MS, plan.trialEndAt.getTime() - 60 * 60 * 1000)),
    ),
    metadata: {
      ...c.metaBase,
      [CATCHUP_META.catchup]: "period",
      [CATCHUP_META.shape]: "trial_one_time",
      [CATCHUP_META.stubCents]: String(stubCents),
      [CATCHUP_META.stubLabel]: plan.stub.label,
      ...span,
    },
    subscription_data: {
      trial_end: epoch(plan.trialEndAt),
      metadata: { ...c.subMetaBase, [CATCHUP_META.catchup]: "period", ...span },
    },
  };
}

/** trial: prepaid, T >= 72 h away. */
function buildTrial(i: CatchupSessionInput): Record<string, any> {
  const { plan } = i;
  const c = common(i);
  const stubCents = plan.stub.totalCents >= STRIPE_MIN_CHARGE_CENTS ? plan.stub.totalCents : 0;
  return {
    ...c.sessionBase,
    payment_method_collection: "always",
    line_items: c.recurring,
    expires_at: epoch(new Date(i.now.getTime() + DAY_MS)),
    metadata: {
      ...c.metaBase,
      [CATCHUP_META.catchup]: "prepaid",
      [CATCHUP_META.shape]: "trial",
      [CATCHUP_META.stubCents]: String(stubCents),
      [CATCHUP_META.stubLabel]: plan.stub.label,
      // r3 N3: the stub is charged at 12:00Z of the paid-through day (the claim service floors it at now + 1 h,
      // because Stripe rejects a past timestamp)
      [CATCHUP_META.finalizeAt]: String(
        epoch(
          new Date(
            Date.UTC(
              plan.paidThrough.getUTCFullYear(),
              plan.paidThrough.getUTCMonth(),
              plan.paidThrough.getUTCDate(),
              12,
            ),
          ),
        ),
      ),
    },
    subscription_data: {
      trial_end: epoch(plan.trialEndAt),
      metadata: { ...c.subMetaBase, [CATCHUP_META.catchup]: "prepaid" },
    },
  };
}

/** anchor_no_line: prepaid, T under 72 h away, nothing to bill before the anchor. */
function buildAnchorNoLine(i: CatchupSessionInput): Record<string, any> {
  const { plan } = i;
  const c = common(i);
  return {
    ...c.sessionBase,
    line_items: c.recurring,
    expires_at: planCheckoutAnchor(i.now).expiresAt,
    metadata: {
      ...c.metaBase,
      [CATCHUP_META.catchup]: "prepaid",
      [CATCHUP_META.shape]: "anchor_no_line",
      [CATCHUP_META.stubCents]: "0",
      [CATCHUP_META.stubLabel]: plan.stub.label,
    },
    subscription_data: {
      billing_cycle_anchor: epoch(plan.anchorAt),
      proration_behavior: "none",
      metadata: { ...c.subMetaBase, [CATCHUP_META.catchup]: "prepaid" },
    },
  };
}

export function buildCatchupSessionParams(i: CatchupSessionInput): Record<string, any> {
  const params =
    i.plan.shape === "trial_one_time"
      ? buildTrialOneTime(i)
      : i.plan.shape === "trial"
        ? buildTrial(i)
        : buildAnchorNoLine(i);
  // the Stripe floor the trial shapes rely on: a trial ends at least 48 h out (we keep 72 h)
  const trialEnd = params.subscription_data?.trial_end;
  if (trialEnd != null && trialEnd * 1000 - i.now.getTime() < CATCHUP_TRIAL_MIN_LEAD_MS) {
    throw new Error("catch-up trial_end is under 72 h away");
  }
  // Decision 5: a prepaid trial's stub must finalize before the trial ends (see CATCHUP_TRIAL_STUB_MIN_LEAD_MS)
  if (
    i.plan.shape === "trial" &&
    i.plan.stub.totalCents >= STRIPE_MIN_CHARGE_CENTS &&
    i.plan.trialEndAt.getTime() - i.now.getTime() < CATCHUP_TRIAL_STUB_MIN_LEAD_MS
  ) {
    throw new Error("catch-up trial with a stub ends under 98 h away");
  }
  assertCheckoutAcceptable(params);
  return params;
}
