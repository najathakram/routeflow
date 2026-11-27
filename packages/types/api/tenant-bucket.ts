/**
 * SA-1535 / W-1462: the super admin business tabs. A business is in exactly ONE bucket (the tab it is counted under);
 * "needs attention" is an overlay on any bucket, never a bucket of its own. The server classifies (`classifyTenantBucket`,
 * apps/api/src/billing/tenant-bucket.ts) and the web only prints. Derived unions, not Prisma enums, so they do not belong
 * in enums.ts or the enum-parity table; the API pins its local copies equal to these lists in a spec.
 */
export const TENANT_BUCKET_VALUES = [
  "paying",
  "trial",
  "not_billed",
  "paused",
  "closed",
  "test_demo",
  "internal",
  "unknown",
] as const;
export type TenantBucket = (typeof TENANT_BUCKET_VALUES)[number];

export const TENANT_ATTENTION_VALUES = [
  "overdue",
  "trial_ended",
  "trial_ending",
  "trial_no_end",
  "needs_reconcile",
  "cancelling",
  "class_slug_mismatch",
  // SA-1539: paying by the one definition (isPayingRow) but the row prices at $0 or has no price snapshot.
  "subscribed_zero",
  // SA-1539: not a real customer by class, yet a live card subscription is still charging.
  "billed_not_production",
  "unknown",
] as const;
export type TenantAttentionReason = (typeof TENANT_ATTENTION_VALUES)[number];

/** One count per bucket, as `meta.bucketCounts` on the tenant list (null when the matching business count is above the scan cap, with `meta.truncated` true). */
export type TenantBucketCounts = Record<TenantBucket, number>;
