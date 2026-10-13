/**
 * Perms PR1: who may administer the account, and the team status in the API's own shape. Pure (no React, no
 * native modules) so Jest can test it. The API decides by ROLE: TENANT_ADMIN, and SUPER_ADMIN (which satisfies
 * every role). Users carry `status` (ACTIVE | INACTIVE | SUSPENDED); there is no `isActive` on the wire.
 */
export type UserStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED";

export function isAccountAdmin(role: string | null | undefined): boolean {
  return role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
}

export function isUserActive(u: { status?: string | null }): boolean {
  return u.status === "ACTIVE";
}

/** PATCH /users/:id/status body: deactivate an active user, re-activate anyone else. */
export function statusToggleBody(u: { status?: string | null }): { status: UserStatus } {
  return { status: isUserActive(u) ? "INACTIVE" : "ACTIVE" };
}
