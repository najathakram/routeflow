// SA-775 (row 381): the platform-admin wire shapes for the rollout pause on AUTOMATIC tenant locks
// (`GET/PATCH /platform-admin/config/auto-locks`, `GET …/auto-locks/preview`). Dates arrive as ISO strings.
// The API side is `AutoLockAdminService` (apps/api/src/billing) - keep these in step with it. A tenant is
// named by id only (no business names) in every list.

/** Why a lock was about to be written; also the suffix of the durable skip claim. */
export const AUTO_LOCK_KIND_VALUES = [
  "trial_expired",
  "subscription_cancelled",
  "overdue_suspended",
  "stripe_cancelled",
  "payment_overdue",
  "trial_cancelled",
] as const;
export type AutoLockKindValue = (typeof AUTO_LOCK_KIND_VALUES)[number];

/** A PRODUCTION tenant an automatic job WOULD lock on its next pass if the switch were unpaused. */
export interface AutoLockWouldLock {
  tenantId: string;
  kind: AutoLockKindValue;
  /** trialEndsAt ISO / periodEnd ISO / Stripe sub id / dunning invoice id. */
  key: string;
  /** Set when the nightly job still has to ask Stripe before it locks (the overdue-subscription sweep). */
  via?: "stripe_check_pending";
}

/** A lock that WAS held (a durable skip record), newest first. */
export interface AutoLockSkippedRow {
  tenantId: string;
  kind: AutoLockKindValue;
  key: string;
  at: string;
}

/** `GET /platform-admin/config/auto-locks` */
export interface AutoLockState {
  /** MISSING key = paused: a fresh platform starts paused. */
  paused: boolean;
  since: string | null;
  reason: string | null;
  wouldLockNow: AutoLockWouldLock[];
  skipped: AutoLockSkippedRow[];
}

/** `GET /platform-admin/config/auto-locks/preview` - read-only; nothing is written to produce it. */
export interface AutoLockPreview {
  generatedAt: string;
  paused: boolean;
  wouldLock: AutoLockWouldLock[];
}

/** `PATCH /platform-admin/config/auto-locks` request. */
export interface SetAutoLockPausedRequest {
  paused: boolean;
  reason: string;
}

/** `PATCH /platform-admin/config/auto-locks` response. */
export interface SetAutoLockPausedResponse {
  paused: boolean;
  since: string | null;
  reason: string | null;
  previous: { paused: boolean; since: string | null; reason: string | null };
}
