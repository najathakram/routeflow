import { UserRole } from "@prisma/client";

const ROLES = new Set<string>(Object.values(UserRole));

/**
 * The one definition of a staff session access token, shared by the HTTP strategy and the
 * socket gateway so the two cannot drift. A staff access token carries a valid `role` and no
 * `type` claim (the buyer realm has its own branch and is not judged here).
 */
export function isStaffSessionPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { sub?: unknown; role?: unknown; type?: unknown };
  if (typeof p.sub !== "string" || !p.sub) return false;
  if (p.type !== undefined) return false;
  return typeof p.role === "string" && ROLES.has(p.role);
}

export const STAFF_ACCESS_AUDIENCE = "staff-access";
export const BUYER_ACCESS_AUDIENCE = "buyer-access";

/**
 * True when the token names an audience and that audience is not `realm`. A token with no `aud`
 * is not judged here (tokens minted before audiences existed carry none).
 */
export function hasForeignAudience(
  payload: unknown,
  realm: typeof STAFF_ACCESS_AUDIENCE | typeof BUYER_ACCESS_AUDIENCE,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const aud = (payload as { aud?: unknown }).aud;
  if (aud === undefined) return false;
  if (typeof aud === "string") return aud !== realm;
  if (Array.isArray(aud)) return aud.length === 0 || aud.some((a) => a !== realm);
  return true;
}
