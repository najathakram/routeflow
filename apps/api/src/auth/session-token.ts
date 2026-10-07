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
