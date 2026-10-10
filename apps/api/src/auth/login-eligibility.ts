/**
 * #2653 (SA-542a/b/c, SA-070): the ONE rule for who may be signed in: staff (User) and buyers
 * (BuyerAccount) alike. Every sign-in path decides here; no path keeps an inline copy:
 *   - AuthService.validateUser and BuyerAuthService.login (password sign-in);
 *   - the one-time handoff exchange (no password), both realms.
 *
 * The rule has two halves because the password paths must keep their timing-oracle ORDER (SA-542c:
 * "the helper decides eligibility, the caller keeps the order"):
 *   1. isSignInBlocked: deleted or locked. Checked BEFORE bcrypt, so a locked account refuses
 *      without running it (no timing oracle, no counter churn).
 *   2. isLoginEligible: not blocked AND status ACTIVE. The password paths consult it only AFTER
 *      bcrypt ran, so a non-ACTIVE account answers exactly like a wrong password (B213). A caller
 *      with no password (the handoff) calls it directly.
 * login-eligibility.spec.ts pins the order and the verdicts against the real login paths.
 */

export interface LoginSubject {
  deletedAt: Date | null;
  lockedUntil: Date | null;
  status: string;
}

/** Deleted, or locked until later than `now`: refuse before any credential is checked. */
export function isSignInBlocked(subject: LoginSubject, now = new Date()): boolean {
  if (subject.deletedAt != null) return true;
  return subject.lockedUntil != null && subject.lockedUntil > now;
}

/** The whole rule: present, not blocked, and ACTIVE. */
export function isLoginEligible(
  subject: LoginSubject | null | undefined,
  now = new Date(),
): subject is LoginSubject {
  if (!subject || isSignInBlocked(subject, now)) return false;
  return subject.status === "ACTIVE";
}
