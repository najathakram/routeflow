/**
 * SA-733r7 PR-B3: the named constants of the dunning clock and the one reader of `BILLING_PAUSE_MODE`.
 * Every threshold the sweep uses is here, so a future per-tenant grace length replaces one constant.
 */

/** Hours from the first failure (`pastDueSince`) until the tenant may be paused: day 7. */
export const DUNNING_PAUSE_HOURS = 168;
/** The d3 reminder is due at +72 h. */
export const DUNNING_D3_HOURS = 72;
/** The d6 reminder ("read-only tomorrow" in `enforced`) is due at +144 h. */
export const DUNNING_D6_HOURS = 144;
/** `dunning_final` must have been sent at least this many hours before a pause (SA-733r M4). */
export const DUNNING_FINAL_LEAD_HOURS = 24;
/** The pause lands on the first sweep at or after this tenant-local hour (SA-733r6). */
export const PAUSE_LOCAL_HOUR = 3;
/** The zone used when a tenant has none configured (the money-date contract of calendar-date.ts). */
export const DUNNING_FALLBACK_ZONE = "UTC";

export const HOUR_MS = 60 * 60 * 1000;

/** `BillingNotificationLog.milestone` values; the log `key` is the Stripe invoice id. */
export const DUNNING_MILESTONES = {
  D0: "DUNNING_D0",
  D3: "DUNNING_D3",
  D6: "DUNNING_D6",
  FINAL: "DUNNING_FINAL",
  PAUSED: "DUNNING_PAUSED",
  /** SA G8: while a tenant stays paused, ONE per episode replaces d0/d3/d6/final. */
  PAUSED_STILL_OWED: "DUNNING_PAUSED_STILL_OWED",
} as const;
export type DunningMilestone = (typeof DUNNING_MILESTONES)[keyof typeof DUNNING_MILESTONES];

/** `Tenant.status` of a paused / cancelled-while-paused workspace (also an API error code name, hence one constant). */
export const READ_ONLY_STATUS = "READ_ONLY" as const;

/** The `readOnlyReason` a dunning pause writes (no new enum: READ_ONLY plus this reason). */
export const PAYMENT_OVERDUE_REASON = "payment_overdue";
/** The `readOnlyReason` a cancel (self-serve, or Stripe's own) leaves a paused tenant on. */
export const SUBSCRIPTION_CANCELLED_REASON = "subscription_cancelled";

/**
 * `off`      nothing is stamped, mailed or paused (exits that heal an existing state still run);
 * `dark`     the default: stamp + log + the reminder notices, NEVER a status change;
 * `enforced` adds the final notice and the pause. The owner flips it after the blast-radius report.
 */
export type BillingPauseMode = "off" | "dark" | "enforced";

/** An unknown or empty value is `dark`: a typo can never turn the pause on. */
export function billingPauseMode(
  env: Record<string, string | undefined> = process.env,
): BillingPauseMode {
  const raw = (env.BILLING_PAUSE_MODE ?? "").trim().toLowerCase();
  return raw === "off" || raw === "enforced" ? raw : "dark";
}

/** Which email path tells a tenant about an unpaid invoice. */
export type DunningEmailPath = "legacy_failed_payment" | "milestones";

/**
 * SA r-note 5 A1: dark is SILENT to tenants. This ONE switch decides which path may email a tenant, and every
 * sender asks it:
 *   - `off` and `dark`: master's failed-payment email (#2440), one per real `invoice.payment_failed`, and nothing
 *     else - the sweep and discovery only stamp and log;
 *   - `enforced`: the d0 / d3 / d6 / final / paused / paused-still-owed series REPLACES that email (a tenant is never
 *     told by both). The series starts only after the owner flips the mode, following the blast-radius report.
 */
export function dunningEmailsFor(mode: BillingPauseMode): DunningEmailPath {
  return mode === "enforced" ? "milestones" : "legacy_failed_payment";
}
