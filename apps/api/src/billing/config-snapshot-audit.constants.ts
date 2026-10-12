/**
 * The audit action for an entitlement-config restore, written by BOTH paths so the admin UI reads
 * one shape: the automatic restore on a re-upgrade (inside the plan-change transaction, by
 * `PlanTransitionConfigService`) and the super-admin "Restore now" (by the platform-admin
 * controller, where it is `AdminAuditAction.CONFIG_SNAPSHOT_RESTORED` — pinned equal by spec).
 * `meta` carries `snapshotId`, `restoredToPlanKey` and `report` {restored, skipped, keptNewer,
 * unchanged} — no migration: the report lives in the existing audit trail.
 */
export const CONFIG_SNAPSHOT_RESTORED_ACTION = "CONFIG_SNAPSHOT_RESTORED";

/**
 * Stripe checkout bookkeeping written into the existing audit trail (no migration), only while the
 * snapshot flag is on. `APPLIED` (entityType `stripe_checkout_session`, entityId = the session id)
 * is the processed-session record: a redelivered `checkout.session.completed` finds it and does
 * nothing, so a late redelivery can never re-run an old plan change over a newer one. `STALE` marks
 * a checkout whose plan change was NOT applied because a downgrade committed after the session was
 * created; `HOOK_FAILED` is the alarm row when the plan-transition hook fails a paid checkout.
 */
export const STRIPE_CHECKOUT_ENTITY = "stripe_checkout_session";
export const STRIPE_CHECKOUT_APPLIED_ACTION = "STRIPE_CHECKOUT_APPLIED";
export const STRIPE_CHECKOUT_STALE_ACTION = "STRIPE_CHECKOUT_PLAN_SKIPPED_STALE";
/** A checkout session refused outright (unknown tenant / a customer that is not the tenant's). */
export const STRIPE_CHECKOUT_REFUSED_ACTION = "STRIPE_CHECKOUT_REFUSED";
/**
 * P0 hotfix (SA-774r2 follows): the notice row of a checkout whose bank debit FAILED
 * (`checkout.session.async_payment_failed`). One row per session; nothing is activated or cancelled by it yet.
 */
export const STRIPE_CHECKOUT_ASYNC_FAILED_ACTION = "STRIPE_CHECKOUT_ASYNC_PAYMENT_FAILED";
/**
 * B1158: a paid checkout PARKED (not applied, nothing cancelled) because the tenant's previous subscription it
 * would supersede has a bank payment (ACH/SEPA PaymentIntent) still `processing`. Keyed by the session id; the
 * hourly sweep (`billing.reconcileParkedCheckouts`) re-runs the checkout handling for every row that has no
 * `STRIPE_CHECKOUT_PARK_RESOLVED` row, and writes ONE `STRIPE_CHECKOUT_PARK_ESCALATED` row (with its platform
 * notice) when a park is still open after PARKED_CHECKOUT_ESCALATE_AFTER_DAYS.
 */
export const STRIPE_CHECKOUT_PAYMENT_PROCESSING_ACTION = "STRIPE_CHECKOUT_PAYMENT_PROCESSING";
export const STRIPE_CHECKOUT_PARK_RESOLVED_ACTION = "STRIPE_CHECKOUT_PARK_RESOLVED";
export const STRIPE_CHECKOUT_PARK_ESCALATED_ACTION = "STRIPE_CHECKOUT_PARK_ESCALATED";
export const PARKED_CHECKOUT_ESCALATE_AFTER_DAYS = 10;
/**
 * The STICKY decision that a completed checkout session is a DUPLICATE (a second paid session for a tenant that
 * already has a live subscription, or one paid after the tenant moved to manual invoicing). Written, keyed by
 * the session id, BEFORE the duplicate subscription is cancelled; a redelivery reads it first and only retries
 * the cancel — it never re-judges.
 */
export const STRIPE_CHECKOUT_DUPLICATE_ACTION = "STRIPE_CHECKOUT_DUPLICATE";
/** An automatic restore that failed or was abandoned: the plan change went ahead without it. */
export const CONFIG_SNAPSHOT_RESTORE_FAILED_ACTION = "CONFIG_SNAPSHOT_RESTORE_FAILED";
export const STRIPE_CHECKOUT_HOOK_FAILED_ACTION = "STRIPE_CHECKOUT_HOOK_FAILED";
