import { createHash } from "node:crypto";
import { CATCHUP_META } from "./catchup-claim";
import { CHECKOUT_MAX_LIFETIME_MS } from "./checkout-anchor";
import { CATCHUP_TRIAL_MIN_LEAD_MS, chargeNowCents, type CatchupPlan } from "./catchup-plan";

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
  const stubCents = chargeNowCents(plan);
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
    // A >= now + 72 h, so this is now + 23 h (min() kept for the contract: never past A - 60 min)
    expires_at: epoch(
      new Date(
        Math.min(
          i.now.getTime() + CHECKOUT_MAX_LIFETIME_MS,
          plan.trialEndAt.getTime() - 60 * 60 * 1000,
        ),
      ),
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
    expires_at: epoch(new Date(i.now.getTime() + CHECKOUT_MAX_LIFETIME_MS)),
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

/** Not terms: where the browser returns to, who the customer is, when the page lapses, and the metadata itself. */
const SIGNATURE_EXCLUDED = new Set([
  "success_url",
  "cancel_url",
  "expires_at",
  "metadata",
  "customer",
]);

/** Stable JSON: object keys sorted at every depth, no whitespace, `undefined` dropped (as JSON.stringify does). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v))
    return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Row 542d / SA-800c: ONE sha256 over the FULL terms of a session, taken from the params object as
 * {@link buildCatchupSessionParams} builds it (the object `open()` then passes through `withCheckoutPolicy`, which
 * adds the constant `managed_payments` AFTER signing; that policy is not a term, so it is not signed). Every
 * top-level param except {@link SIGNATURE_EXCLUDED} is signed (so a param added to the builder later is covered
 * automatically), and `subscription_data` without its own `metadata`. The line items are signed whole: price, amount,
 * interval, currency, product name and quantity of the recurring, add-on and one-time lines. Idempotency keys are not
 * params, and no timestamp or URL is signed.
 */
export function catchupTermsSignature(params: Record<string, any>): string {
  const terms: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!SIGNATURE_EXCLUDED.has(k)) terms[k] = v;
  if (terms.subscription_data && typeof terms.subscription_data === "object") {
    const { metadata: _own, ...rest } = terms.subscription_data as Record<string, unknown>;
    terms.subscription_data = rest;
  }
  // a forgiven line has no line item: its amount (metadata only, audit) is still a term of the session
  terms.forgiven_cents = params.metadata?.[CATCHUP_META.forgivenCents] ?? null;
  // the plan key is metadata only (the line shows just the plan's display name): two plans can share a name and a price
  terms.plan_key = params.metadata?.planKey ?? null;
  return createHash("sha256").update(canonicalJson(terms)).digest("hex");
}

/** A catch-up session is built with a sha256 terms signature, always (SA-800d G1). */
export function assertSignedSession(params: { metadata?: Record<string, unknown> }): void {
  const sig = params.metadata?.[CATCHUP_META.termsSig];
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) {
    throw new Error("catch-up session params must carry a 64-hex terms signature");
  }
}

export function buildCatchupSessionParams(
  i: CatchupSessionInput,
  // injectable only so a spec can prove the assertion below fires; production always signs
  sign: (params: Record<string, any>) => string = catchupTermsSignature,
): Record<string, any> {
  const params = i.plan.shape === "trial_one_time" ? buildTrialOneTime(i) : buildTrial(i);
  // the Stripe floor the trial shapes rely on: a trial ends at least 48 h out (we keep 72 h)
  const trialEnd = params.subscription_data?.trial_end;
  if (trialEnd != null && trialEnd * 1000 - i.now.getTime() < CATCHUP_TRIAL_MIN_LEAD_MS) {
    throw new Error("catch-up trial_end is under 72 h away");
  }
  assertCheckoutAcceptable(params);
  params.metadata[CATCHUP_META.termsSig] = sign(params);
  assertSignedSession(params);
  return params;
}
