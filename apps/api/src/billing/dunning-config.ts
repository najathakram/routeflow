/**
 * SA-733r7 PR-B3: the named constants of the dunning clock and the one reader of `BILLING_PAUSE_MODE`.
 * Every threshold the sweep uses is here, so a future per-tenant grace length replaces one constant.
 */
import type { Prisma } from "@prisma/client";

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
/** F4: the `readOnlyReason` of a READ_ONLY an admin set by hand - a payment never reinstates it. */
export const ADMIN_SET_REASON = "admin_set";
/** The `readOnlyReason` a cancel (self-serve, or Stripe's own) leaves a paused tenant on. */
export const SUBSCRIPTION_CANCELLED_REASON = "subscription_cancelled";
/**
 * SA-832b: the `readOnlyReason` a STRIPE churn (customer.subscription.deleted / updated to `canceled`) leaves on a
 * CANCELLED tenant. A churn is not an admin decision: the back-office win-back checkout link and a payment may bring the
 * tenant back, so {@link paymentReinstatable} lets it through. An admin's CANCELLED carries {@link ADMIN_SET_REASON}; a
 * legacy CANCELLED row carries NONE and stays refused (safe) until a backfill classifies it.
 */
export const STRIPE_CANCELLED_REASON = "stripe_cancelled";
/**
 * W-664 (SA-846): the `readOnlyReason` the overdue cron stamps on the SUSPENDED it writes (a Stripe-cancelled
 * subscription). It is a billing lock, so {@link paymentReinstatable} lifts it. Rows suspended before this stamp carry
 * NO reason and are still lifted (dual-read) until the SA-846 prod census reads 0 NULL SUSPENDED rows; only then may the
 * NULL acceptance be dropped, in its own diff.
 */
export const OVERDUE_SUSPENDED_REASON = "overdue_suspended";
/** A lapsed / cancelled trial's READ_ONLY reasons all start with this (`trial_expired`, `trial_cancelled`). */
export const TRIAL_REASON_PREFIX = "trial_";
const TRIAL_STATUS = "TRIAL" as const;

/**
 * SA-832 row 453: THE ONE predicate for "may a payment lift this tenant's lock?" Only a BILLING-caused lock lifts;
 * a lock an administrator set is a decision a payment must never undo. Every writer that can take a tenant to
 * ACTIVE because money arrived asks THIS function (or its CAS twin {@link paymentReinstatableWhere}):
 *   - `invoice.payment_succeeded` (BillingService.onPaymentSucceeded);
 *   - the checkout completion (BillingService.onCheckoutCompleted);
 *   - `subscribe()` (SubscriptionMutationService), and checkout CREATION - refused up front so the platform never
 *     takes money it will not honour.
 *
 * Lifts: ACTIVE (nothing to lift: an ordinary renewal), TRIAL, READ_ONLY with a `trial_*`, `payment_overdue` or
 * `subscription_cancelled` reason, SUSPENDED unless an admin stamped it {@link ADMIN_SET_REASON} (the billing
 * suspensions carry {@link OVERDUE_SUSPENDED_REASON}; rows from before W-664 carry none), and CANCELLED by a Stripe churn
 * ({@link STRIPE_CANCELLED_REASON}, SA-832b).
 * Never lifts: READ_ONLY(admin_set), READ_ONLY with no / an unknown reason (a legacy admin write), SUSPENDED(admin_set),
 * any other CANCELLED (an admin's, or a legacy row with no reason), and any unknown or missing status.
 */
export function paymentReinstatable(
  status: string | null | undefined,
  readOnlyReason: string | null | undefined,
): boolean {
  const reason = readOnlyReason ?? null;
  switch (status) {
    case "ACTIVE":
    case TRIAL_STATUS:
      return true;
    case READ_ONLY_STATUS:
      return (
        reason !== null &&
        (reason.startsWith(TRIAL_REASON_PREFIX) ||
          reason === PAYMENT_OVERDUE_REASON ||
          reason === SUBSCRIPTION_CANCELLED_REASON)
      );
    case "SUSPENDED":
      return reason !== ADMIN_SET_REASON;
    case "CANCELLED":
      return reason === STRIPE_CANCELLED_REASON;
    default:
      return false;
  }
}

/**
 * The same predicate as a Prisma filter for a compare-and-swap, so the lock check and the status write are ONE
 * statement (an admin who locks the tenant between a read and the write can never be overwritten). Combine with the
 * caller's own `status: { not: "ACTIVE" }`; a database spec pins that this selects exactly the rows
 * {@link paymentReinstatable} allows. (SQL: `readOnlyReason <> 'admin_set'` is never true for NULL, hence the OR.)
 */
export function paymentReinstatableWhere(): Prisma.TenantWhereInput {
  return {
    OR: [
      { status: TRIAL_STATUS },
      {
        status: READ_ONLY_STATUS,
        OR: [
          { readOnlyReason: { startsWith: TRIAL_REASON_PREFIX } },
          { readOnlyReason: { in: [PAYMENT_OVERDUE_REASON, SUBSCRIPTION_CANCELLED_REASON] } },
        ],
      },
      {
        status: "SUSPENDED",
        OR: [{ readOnlyReason: null }, { readOnlyReason: { not: ADMIN_SET_REASON } }],
      },
      { status: "CANCELLED", readOnlyReason: STRIPE_CANCELLED_REASON },
    ],
  };
}

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

/**
 * Row 346: master's failed-payment email (the off/dark path) is sent at most ONCE PER INVOICE per this many days.
 * Stripe re-fires `invoice.payment_failed` on every retry of the same invoice; without this each retry mailed the
 * admin again. A whole number of days of its own: 7 matches the dunning ladder's span (`DUNNING_PAUSE_HOURS` = 168) TODAY,
 * so an invoice still unpaid after the whole retry window gets one more nudge instead of silence, but the two are
 * independent - changing the pause hours does not move this window (and vice versa).
 */
export const PAYMENT_FAILED_EMAIL_DEDUPE_DAYS = 7;
/** The `EmailDelivery.kind` / `entityType` the failed-payment email is recorded under (entityId = the Stripe invoice id). */
export const PAYMENT_FAILED_EMAIL_KIND = "PAYMENT_FAILED" as const;
export const PAYMENT_FAILED_EMAIL_ENTITY_TYPE = "StripeInvoice";
/**
 * A prior delivery row counts as "already told the admin" only when the mail really went out: SENT. A FAILED row
 * (never sent), a WOULD_SEND row (a dark record) and a QUEUED row (written before a handoff that may never complete)
 * must NOT suppress the next retry's email. Today EmailService.send writes only SENT or FAILED for this kind.
 */
export const PAYMENT_FAILED_EMAIL_DEDUPE_STATUSES = ["SENT"] as const;

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
