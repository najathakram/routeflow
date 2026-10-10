import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";

/**
 * Admin account protection (B1056, B1061): an account with the TENANT_ADMIN role can only be changed by a
 * TENANT_ADMIN caller. Decided by ROLE (`isAdmin` is not on the request user). Fail-closed: a missing caller
 * role never passes for an admin target. The ONE rule shared by the users module (the guarded actions) and
 * the drivers module: DELETE /drivers/:id, PATCH /drivers/:id/status, and PATCH /drivers/:id only when the
 * edit touches an identity field (see DRIVER_IDENTITY_FIELDS). Call it before any write or external call.
 */
export function assertMayChangeAccount(
  target: { role: UserRole },
  callerRole: UserRole | undefined,
): void {
  if (target.role === UserRole.TENANT_ADMIN && callerRole !== UserRole.TENANT_ADMIN) {
    throw new ForbiddenException("Only an account owner can change an admin account.");
  }
}

/**
 * The driver-edit keys that count as IDENTITY / ACCOUNT-LINKING (B1061): the user link, the login identity
 * (email, username, as the users module guards) and the name. Every other driver field (vehicle, phone, home
 * address, ...) is operational and stays editable by an operator on an admin-linked driver.
 */
export const DRIVER_IDENTITY_FIELDS = ["userId", "email", "username", "contactName"] as const;

/**
 * True when a driver edit CHANGES an identity field against the stored driver row (an unchanged value echoed
 * back by the edit form passes, as in the users module). A key the row does not hold (email, username) counts
 * as a change whenever it is sent.
 */
export function touchesDriverIdentity(
  dto: object,
  stored: { userId?: string | null; contactName?: string | null },
): boolean {
  const sent = dto as Record<string, unknown>;
  const row = stored as Record<string, unknown>;
  const norm = (v: unknown) => (typeof v === "string" ? v.trim() : v);
  return DRIVER_IDENTITY_FIELDS.some(
    (key) => sent[key] !== undefined && norm(sent[key]) !== norm(row[key]),
  );
}
