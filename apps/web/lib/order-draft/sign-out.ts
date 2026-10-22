import { mirrorPrefix, type DraftMirrorStorage } from "./storage";

/**
 * SA-817 (A) 6 / A8: leaving with unsent work.
 *  - An EXPLICIT sign-out with unsent orders on this device asks first ("You have 1 unsent order on this device").
 *  - A session EXPIRY (the refresh token lapsed, or another tab signed out) never asks and never touches the local copies:
 *    the same user's next sign-in finds them. Nothing here ever deletes a local copy, either way.
 * Only this tenant + user's copies are counted (A7).
 */
export type SignOutReason = "explicit" | "expired";

export interface SignOutDecision {
  /** Show the confirmation before signing out. */
  ask: boolean;
  /** Local copies are deleted by sign-out: never (nothing is auto-deleted). Present so a caller cannot forget the rule. */
  wipeLocalCopies: false;
}

export function signOutDecision(reason: SignOutReason, unsent: number): SignOutDecision {
  return { ask: reason === "explicit" && unsent > 0, wipeLocalCopies: false };
}

export function unsentOrderCopy(count: number): string {
  return `You have ${count} unsent ${count === 1 ? "order" : "orders"} on this device`;
}

/** Unsent = a local copy of this tenant + user that was not submitted. */
export async function countUnsentOrders(
  storage: DraftMirrorStorage,
  tenantId: string | null | undefined,
  userId: string | null | undefined,
): Promise<number> {
  if (!tenantId || !userId) return 0;
  try {
    const records = await storage.list(mirrorPrefix(tenantId, userId));
    return records.filter((r) => !(r.payload as { submittedAt?: unknown }).submittedAt).length;
  } catch {
    return 0; // an unreadable store must never trap the user on the page
  }
}
