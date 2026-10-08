import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";

/**
 * Admin account protection (B1056): an account with the TENANT_ADMIN role can only be changed, or have its
 * driver record removed, by a TENANT_ADMIN caller. Decided by ROLE (`isAdmin` is not on the request user).
 * Fail-closed: a missing caller role never passes for an admin target. The ONE rule shared by the users
 * module and DELETE /drivers/:id; call it before any write.
 */
export function assertMayChangeAccount(
  target: { role: UserRole },
  callerRole: UserRole | undefined,
): void {
  if (target.role === UserRole.TENANT_ADMIN && callerRole !== UserRole.TENANT_ADMIN) {
    throw new ForbiddenException("Only an account owner can change an admin account.");
  }
}
