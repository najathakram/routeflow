import { UserRole } from "@prisma/client";
import type { OperatorPermissionGroup } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  ALL_PERMISSION_GROUPS,
  OperatorPermissionsService,
  type PermissionPrincipal,
} from "./operator-permissions.service";

/**
 * The groups an OPERATOR is denied, read live from the user row (never a JWT claim, never cached). Everyone
 * else is `[]`: TENANT_ADMIN and SUPER_ADMIN (impersonation tokens carry TENANT_ADMIN) always pass, and no
 * permissions read is made for them. `effective()` reports groups HELD, so denied = all groups minus held;
 * an OPERATOR with no row holds nothing, so every group is denied (fail closed).
 *
 * Lives here, beside the service it reads through, so the till (live by an owner-ruled slice, BO-07) and the
 * price-edit helper (`price-edit.ts`, mode-aware) share the one deny-list read.
 */
export async function operatorDeniedGroups(
  prisma: PrismaService,
  user: PermissionPrincipal,
): Promise<OperatorPermissionGroup[]> {
  if (user.role !== UserRole.OPERATOR) return [];
  const held = new Set((await new OperatorPermissionsService(prisma).effective(user)).groups);
  return ALL_PERMISSION_GROUPS.filter((group) => !held.has(group));
}
