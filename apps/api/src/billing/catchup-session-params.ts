import { CATCHUP_META } from "./catchup-claim";
import {
  CATCHUP_TRIAL_MIN_LEAD_MS,
  STRIPE_MIN_CHARGE_CENTS,
  type CatchupPlan,
} from "./catchup-plan";

/**
 * The Stripe Checkout parameters of a catch-up session - a PURE function of the plan, ONE builder per shape. Only
 * shapes Stripe's Checkout documentation allows are built (docs.stripe.com/payments/checkout/billing-cycle,
 * "Limitations"; docs.stripe.com/billing/subscriptions/trials/free-trials). Two shapes are reachable (SA-733r9 G4):
 *
 *   trial_one_time `subscription_data.trial_end = A` alone (A = the first 1st at 12:00Z >= max(now + 72 h, S); no
 *                  explicit billing_cycle_anchor, no proration_behavior), the recurring lines, and ONE one-time line =
 *                  [S, A) (base + add-ons, prorated), charged at completion. A line under $0.50 is forgiven: no line,
 *                  `catchup_stub_cents` "0" and `catchup_forgiven_cents` for the claim's audit row.
 *   trial          S === A: `trial_end = A` alone, recurring lines only, no line (ruling 8(e)).
 *
 * EVERY shape writes `catchup_from` (= S) and `catchup_to` (= A) on the session metadata: settle reads them and never
 * recomputes paid coverage (MF-A / MF-B). The session never carries `discounts` or `allow_promotion_codes` (no
 * coupons in the catch-up, so the paid amount always equals the promised line).
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
      ...(plan.stub.belowStripeMinimum
        ? { [CATCHUP_META.forgivenCents]: String(plan.stub.totalCents) }
        : {}),
      ...span,
    },
    subscription_data: {
      trial_end: epoch(plan.trialEndAt),
      metadata: { ...c.subMetaBase, [CATCHUP_META.catchup]: "period", ...span },
    },
  };
}

/** trial: S === A (paid exactly through a 1st at least 72 h out, ruling 8(e)): no line, trial_end = A alone. */
function buildTrial(i: CatchupSessionInput): Record<string, any> {
  const { plan } = i;
  const c = common(i);
  // MF-B: BOTH keys on every shape (here S === A), so settle has one metadata contract to read
  const span = {
    [CATCHUP_META.from]: plan.stub.from.toISOString(),
    [CATCHUP_META.to]: plan.stub.to.toISOString(),
  };
  return {
    ...c.sessionBase,
    payment_method_collection: "always",
    line_items: c.recurring,
    expires_at: epoch(new Date(i.now.getTime() + DAY_MS)),
    metadata: {
      ...c.metaBase,
      [CATCHUP_META.catchup]: "prepaid",
      [CATCHUP_META.shape]: "trial",
      [CATCHUP_META.stubCents]: "0",
      [CATCHUP_META.stubLabel]: plan.stub.label,
      ...span,
    },
    subscription_data: {
      trial_end: epoch(plan.trialEndAt),
      metadata: { ...c.subMetaBase, [CATCHUP_META.catchup]: "prepaid", ...span },
    },
  };
}

export function buildCatchupSessionParams(i: CatchupSessionInput): Record<string, any> {
  const params = i.plan.shape === "trial_one_time" ? buildTrialOneTime(i) : buildTrial(i);
  // the Stripe floor the trial shapes rely on: a trial ends at least 48 h out (we keep 72 h)
  const trialEnd = params.subscription_data?.trial_end;
  if (trialEnd != null && trialEnd * 1000 - i.now.getTime() < CATCHUP_TRIAL_MIN_LEAD_MS) {
    throw new Error("catch-up trial_end is under 72 h away");
  }
  assertCheckoutAcceptable(params);
  return params;
}
