/**
 * Hard dates for the links that predate single-use stored tokens, and the issue-time cut-off for
 * the staff verification resend. Plain constants on purpose: nothing reads them from config or
 * the environment, so a deploy cannot move them by accident.
 *
 * A legacy link is a stateless signed link (verification) or a plaintext column value (invite)
 * that cannot be revoked once issued. It stays accepted only until the date below; after that the
 * consumer answers exactly as it does for any other dead link. Every value is a `Date`.
 */

/** The last instant a stateless signed verification link is still accepted (deploy + 24h). */
export const LEGACY_VERIFY_ACCEPT_UNTIL = new Date("2026-10-14T00:00:00.000Z");

/** The last instant a plaintext customer-link invite value is still accepted. */
export const LEGACY_INVITE_ACCEPT_UNTIL = new Date("2026-10-20T00:00:00.000Z");

/** The last instant a buyer-merge verification link with its token in the URL path is accepted. */
export const LEGACY_MERGE_LINK_ACCEPT_UNTIL = new Date("2026-10-15T00:00:00.000Z");

/**
 * Accounts created before this instant never get a verification link from the resend path: their
 * sign-in timestamp is not reliable, so they stay on the back-office route. It applies only when a
 * link is ISSUED; a stored token that already exists is consumed with no creation-date check.
 */
export const VERIFY_RESEND_CUTOFF = new Date("2026-09-29T00:00:00.000Z");

/** True while a legacy stateless verification link is still inside its window. */
export function legacyVerifyAccepted(now: Date): boolean {
  return now.getTime() < LEGACY_VERIFY_ACCEPT_UNTIL.getTime();
}

/** True while a legacy buyer-merge link (token in the URL path) is still inside its window. */
export function legacyMergeLinkAccepted(now: Date): boolean {
  return now.getTime() < LEGACY_MERGE_LINK_ACCEPT_UNTIL.getTime();
}
