/**
 * Who may use an emailed verification link to be activated and signed in.
 *
 * Only a signup admin that has never signed in. Every other account (already active, any other
 * role, signed in before, holding a session row, or created before the sign-in timestamp was
 * recorded) is refused and must sign in the normal way.
 */

/** Earliest creation date for which the sign-in timestamp (`User.lastLoginAt`) is reliable. */
export const SIGN_IN_TIMESTAMP_RELIABLE_FROM = new Date("2026-09-29T00:00:00.000Z");

/** Coded 400 payload for a refused link. Same copy for every refused class. */
export const VERIFICATION_REFUSED = {
  statusCode: 400,
  code: "ALREADY_VERIFIED",
  message: "Already verified — please sign in",
  error: "Bad Request",
} as const;

export interface VerificationCandidate {
  id: string;
  role: string;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface SessionRowCounter {
  refreshToken: { count(args: { where: { userId: string } }): Promise<number> };
}

export async function mayUseVerificationLink(
  db: SessionRowCounter,
  user: VerificationCandidate,
): Promise<boolean> {
  if (user.status !== "INACTIVE") return false;
  if (user.role !== "TENANT_ADMIN") return false;
  if (user.lastLoginAt) return false;
  if (!(user.createdAt instanceof Date) || user.createdAt < SIGN_IN_TIMESTAMP_RELIABLE_FROM) {
    return false;
  }
  return (await db.refreshToken.count({ where: { userId: user.id } })) === 0;
}
