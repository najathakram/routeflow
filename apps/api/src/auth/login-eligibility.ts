/**
 * #2653 (SA-542a/b): who may be signed in WITHOUT a password — the one-time handoff exchange —
 * decided by the SAME rule the password logins apply after the password checks out:
 *   - staff: AuthService.validateUser (not deleted, not locked, status ACTIVE);
 *   - buyers: BuyerAuthService.login (not deleted, not locked, status ACTIVE).
 * validateUser and buyer login keep their own ordering (lock before bcrypt, status after, for the
 * timing reasons documented there); these helpers restate the final rule for a caller that has no
 * password to check, and login-eligibility.spec.ts pins them to the login paths so the two can
 * never drift.
 */

export interface LoginEligibleUser {
  deletedAt: Date | null;
  lockedUntil: Date | null;
  status: string;
}

export function isLoginEligible(
  user: LoginEligibleUser | null | undefined,
  now = new Date(),
): boolean {
  if (!user || user.deletedAt !== null) return false;
  if (user.lockedUntil && user.lockedUntil > now) return false;
  return user.status === "ACTIVE";
}

export interface LoginEligibleBuyerAccount {
  deletedAt: Date | null;
  lockedUntil: Date | null;
  status: string;
}

export function isBuyerLoginEligible(
  account: LoginEligibleBuyerAccount | null | undefined,
  now = new Date(),
): boolean {
  if (!account || account.deletedAt) return false;
  if (account.lockedUntil && account.lockedUntil > now) return false;
  return account.status === "ACTIVE";
}
