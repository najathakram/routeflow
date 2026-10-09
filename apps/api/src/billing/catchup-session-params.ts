import { BadRequestException } from "@nestjs/common";
import { planCheckoutAnchor } from "./checkout-anchor";
import { CATCHUP_META } from "./catchup-claim";
import { STRIPE_MIN_CHARGE_CENTS, type CatchupPlan } from "./catchup-plan";

/**
 * The Stripe Checkout parameters of a catch-up session - a PURE function of the plan.
 *
 * Only the two shapes Stripe's Checkout documentation allows are built (docs.stripe.com/payments/checkout/
 * billing-cycle, "Limitations"; docs.stripe.com/billing/subscriptions/trials/free-trials):
 *
 *   trial          `subscription_data.trial_end = T` alone. The anchor follows the trial end, so NO explicit
 *                  `billing_cycle_anchor` (Checkout: "You can't use trials in Checkout Sessions with a billing cycle
 *                  anchor"). Recurring lines only; the stub is a post-completion invoice (catchup-claim.service).
 *   anchor_no_line `billing_cycle_anchor` + `proration_behavior: "none"` and NO one-time line (Checkout: "You can't
 *                  use one-time prices in Checkout Sessions when proration_behavior is none").
 *
 * `needs_ruling` is never built. {@link assertCheckoutAcceptable} is the structural guard that any params object
 * respects both limits, and runs on everything this module returns.
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

/** The Checkout-documented limits, as an invariant. Throws on a combination Stripe rejects. */
export function assertCheckoutAcceptable(params: {
  line_items?: { price_data?: { recurring?: unknown } }[];
  subscription_data?: Record<string, unknown>;
}): void {
  const sd = params.subscription_data ?? {};
  const hasTrial = sd.trial_end != null || sd.trial_period_days != null;
  if (hasTrial && sd.billing_cycle_anchor != null) {
    throw new Error("Checkout rejects a trial combined with billing_cycle_anchor");
  }
  if (sd.proration_behavior === "none") {
    const oneTime = (params.line_items ?? []).some((l) => !l.price_data?.recurring);
    if (oneTime) throw new Error("Checkout rejects a one-time line with proration_behavior=none");
  }
}

export function buildCatchupSessionParams(i: CatchupSessionInput): Record<string, any> {
  const { plan } = i;
  if (plan.shape === "needs_ruling") {
    throw new BadRequestException("This catch-up has no Checkout shape yet (needs a ruling).");
  }
  const stubCents = plan.stub.totalCents >= STRIPE_MIN_CHARGE_CENTS ? plan.stub.totalCents : 0;
  const baseMeta = {
    tenantId: i.tenantId,
    slug: i.slug,
    planKey: i.planKey,
    interval: "month",
    ...(i.addonSkus.length ? { addonSkus: i.addonSkus.join(",") } : {}),
  };
  const lineItems = [{ price_data: i.planPriceData, quantity: 1 }, ...i.addonLines];

  let params: Record<string, any>;
  if (plan.shape === "trial") {
    const subMeta = {
      tenantId: i.tenantId,
      ...(i.addonSkus.length ? { addonSkus: i.addonSkus.join(",") } : {}),
      [CATCHUP_META.catchup]: "prepaid",
    };
    params = {
      customer: i.customerId,
      mode: "subscription",
      payment_method_collection: "always",
      line_items: lineItems,
      success_url: i.successUrl,
      cancel_url: i.cancelUrl,
      expires_at: epoch(new Date(i.now.getTime() + 24 * 60 * 60 * 1000)),
      metadata: {
        ...baseMeta,
        [CATCHUP_META.catchup]: "prepaid",
        [CATCHUP_META.shape]: "trial",
        [CATCHUP_META.stubCents]: String(stubCents),
        [CATCHUP_META.stubLabel]: plan.stub.label,
        [CATCHUP_META.finalizeAt]: String(epoch(plan.paidThrough)),
      },
      subscription_data: { trial_end: epoch(plan.trialEndAt), metadata: subMeta },
    };
  } else {
    const anchor = planCheckoutAnchor(i.now);
    const month = `${plan.paidThrough.getUTCFullYear()}-${String(plan.paidThrough.getUTCMonth() + 1).padStart(2, "0")}`;
    params = {
      customer: i.customerId,
      mode: "subscription",
      line_items: lineItems,
      success_url: i.successUrl,
      cancel_url: i.cancelUrl,
      expires_at: anchor.expiresAt,
      metadata: {
        ...baseMeta,
        [CATCHUP_META.catchup]: month,
        [CATCHUP_META.shape]: "anchor_no_line",
        [CATCHUP_META.stubCents]: "0",
        [CATCHUP_META.stubLabel]: plan.stub.label,
      },
      subscription_data: {
        billing_cycle_anchor: epoch(plan.anchorAt),
        proration_behavior: "none",
        metadata: {
          tenantId: i.tenantId,
          ...(i.addonSkus.length ? { addonSkus: i.addonSkus.join(",") } : {}),
          [CATCHUP_META.catchup]: month,
        },
      },
    };
  }
  assertCheckoutAcceptable(params);
  return params;
}
