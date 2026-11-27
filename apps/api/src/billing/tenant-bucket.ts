import type { TenantAttentionReason, TenantBucket } from "@routeflow/types";
import { classifyTenantSlug } from "../tenant/tenant-class";
import { TRIAL_NOTICE_DAYS } from "./billing-status";
import { cardBillingState } from "./card-billing-state";
import {
  ADMIN_SET_REASON,
  PAYMENT_OVERDUE_REASON,
  READ_ONLY_STATUS,
  STRIPE_CANCELLED_REASON,
  SUBSCRIPTION_CANCELLED_REASON,
  TRIAL_REASON_PREFIX,
} from "./dunning-config";
import { isPayingRow, type PayingPriceClass } from "./mrr.service";

/**
 * SA-1535 / SA-1539 / W-1462: which business tab a business is under. Pure and clock-free (`now` is a parameter): a
 * stored shape and a price class in, a verdict out. "Paying" is NOT decided by restating a rule: it is `isPayingRow`
 * (the one definition MRR and the add-on ledger share, SA-140, called once below) AND a price class of `paying` (the
 * one price rule, `payingPriceClass` in mrr.service.ts, computed by the caller in one batch). Every business lands in
 * exactly one bucket (first hit wins); attention is an overlay on any bucket and never a bucket of its own, so a paying
 * business in dunning stays in Paying. `unknown` is only for a class or status outside the shared enums.
 */
export interface TenantBucketInput {
  slug: string;
  class: string;
  status: string;
  deletedAt: Date | null;
  trialEndsAt: Date | null;
  readOnlyReason: string | null;
  subscription: {
    planKey: string | null;
    couponFull: boolean;
    pastDueSince: Date | null;
    needsReconcile: boolean;
    cancelAtPeriodEnd: boolean;
    stripeSubId: string | null;
    stripeCustomerId: string | null;
    catchupState: string | null;
  } | null;
}

export interface TenantBucketResult {
  bucket: TenantBucket;
  attention: TenantAttentionReason[];
  trialDaysLeft: number | null;
}

/** Exhaustive over the shared unions: a new member fails to compile here, and tenant-bucket.spec.ts pins both equal. */
export const BUCKET_SET: Record<TenantBucket, true> = {
  paying: true,
  trial: true,
  not_billed: true,
  paused: true,
  closed: true,
  test_demo: true,
  internal: true,
  unknown: true,
};
export const ATTENTION_SET: Record<TenantAttentionReason, true> = {
  overdue: true,
  trial_ended: true,
  trial_ending: true,
  trial_no_end: true,
  needs_reconcile: true,
  cancelling: true,
  class_slug_mismatch: true,
  subscribed_zero: true,
  billed_not_production: true,
  unknown: true,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The two trial lock reasons have no constants of their own in dunning-config.ts, only the shared prefix. */
export const TRIAL_EXPIRED_REASON = `${TRIAL_REASON_PREFIX}expired`;
export const TRIAL_CANCELLED_REASON = `${TRIAL_REASON_PREFIX}cancelled`;

/**
 * SA-1541 B3: READ_ONLY is not one thing. The ONE exhaustive map from a lock reason to the tab (keyed by the dunning-config
 * constants, no reason string typed here; tenant-bucket.spec.ts pins that every known reason has a row). "Paused" is the
 * owner's tab name, not a status (TenantStatus has no PAUSED): we or the dunning clock locked it and it can come back.
 * A reason not in this map is paused WITH the unknown reason (loud); no reason (legacy) is paused quietly.
 */
export const READ_ONLY_REASON_BUCKET: Record<string, { bucket: "paused" | "closed" | "trial" }> = {
  [PAYMENT_OVERDUE_REASON]: { bucket: "paused" },
  [ADMIN_SET_REASON]: { bucket: "paused" },
  [SUBSCRIPTION_CANCELLED_REASON]: { bucket: "closed" },
  // defensive: READ_ONLY never carries this today (only CANCELLED does, billing.service.ts cancelFromStripe), but if it ever
  // does it is closed, not paused
  [STRIPE_CANCELLED_REASON]: { bucket: "closed" },
  [TRIAL_CANCELLED_REASON]: { bucket: "closed" },
  [TRIAL_EXPIRED_REASON]: { bucket: "trial" },
};

function readOnlyBucket(reason: string | null): "paused" | "closed" | "trial" {
  const hit =
    reason != null && Object.prototype.hasOwnProperty.call(READ_ONLY_REASON_BUCKET, reason)
      ? READ_ONLY_REASON_BUCKET[reason]
      : undefined;
  return hit?.bucket ?? "paused";
}

/**
 * The one place the paying predicate is called for a scanned row. The list asks THIS, with the row it scanned, to learn
 * which rows need pricing; it never calls the predicate itself.
 */
export function isPayingScanRow(row: TenantBucketInput): boolean {
  const s = row.subscription;
  return isPayingRow(row, s?.planKey ?? null, s?.couponFull ?? false);
}

function bucketFor(row: TenantBucketInput, priceClass: PayingPriceClass | null): TenantBucket {
  if (row.class === "TEST" || row.class === "DEMO") return "test_demo";
  if (row.class === "INTERNAL") return "internal";
  if (row.class !== "PRODUCTION") return "unknown";
  if (row.deletedAt != null || row.status === "CANCELLED") return "closed";
  if (row.status === "SUSPENDED") return "paused";
  if (row.status === READ_ONLY_STATUS) return readOnlyBucket(row.readOnlyReason);
  if (row.status === "TRIAL") return "trial";
  if (row.status === "ACTIVE") {
    return isPayingScanRow(row) && priceClass === "paying" ? "paying" : "not_billed";
  }
  return "unknown";
}

/**
 * `priceClass` is `payingPriceClass`'s answer for a row where isPayingRow is true, and null for every other row.
 */
export function classifyTenantBucket(
  row: TenantBucketInput,
  priceClass: PayingPriceClass | null,
  now: Date,
): TenantBucketResult {
  const bucket = bucketFor(row, priceClass);
  const s = row.subscription;
  const isTrial = row.status === "TRIAL";
  const end = row.trialEndsAt;
  const msLeft = end ? end.getTime() - now.getTime() : null;
  const trialDaysLeft = isTrial && msLeft != null ? Math.max(0, Math.ceil(msLeft / DAY_MS)) : null;

  const flags: Record<TenantAttentionReason, boolean> = {
    overdue:
      s?.pastDueSince != null ||
      (row.status === READ_ONLY_STATUS && row.readOnlyReason === PAYMENT_OVERDUE_REASON),
    trial_ended:
      (isTrial && msLeft != null && msLeft < 0) ||
      (row.status === READ_ONLY_STATUS && row.readOnlyReason === TRIAL_EXPIRED_REASON),
    trial_ending:
      isTrial && msLeft != null && msLeft >= 0 && (trialDaysLeft ?? 0) <= TRIAL_NOTICE_DAYS,
    trial_no_end: isTrial && end == null,
    needs_reconcile: s?.needsReconcile === true,
    cancelling: s?.cancelAtPeriodEnd === true,
    // SA-1538/SA-1541 B5: ONLY a test-pattern slug classed PRODUCTION. An ordinary slug classed TEST, DEMO or INTERNAL is the
    // normal state of a hand-made test account, so it never fires.
    class_slug_mismatch:
      row.class === "PRODUCTION" && classifyTenantSlug(row.slug) !== "PRODUCTION",
    subscribed_zero: priceClass === "unpriced" || priceClass === "zero_priced",
    billed_not_production: row.class !== "PRODUCTION" && cardBillingState(row, s) === "live",
    unknown:
      bucket === "unknown" ||
      (row.status === READ_ONLY_STATUS &&
        row.readOnlyReason != null &&
        !Object.prototype.hasOwnProperty.call(READ_ONLY_REASON_BUCKET, row.readOnlyReason)),
  };
  const attention = (Object.keys(ATTENTION_SET) as TenantAttentionReason[]).filter((k) => flags[k]);
  return { bucket, attention, trialDaysLeft };
}
