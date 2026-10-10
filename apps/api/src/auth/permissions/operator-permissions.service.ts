import { Injectable } from "@nestjs/common";
import { OperatorPermissionGroup, UserRole } from "@prisma/client";
import type { MyPermissions, PermissionsMode } from "@routeflow/types";
import { PrismaService } from "../../prisma/prisma.service";

/** The mode `GET /users/me/permissions` reports. Always "shadow" in this release (nothing is enforced). */
export const PERMISSIONS_MODE: PermissionsMode = "shadow";

/**
 * Every feature group, in display order. Derived from the Prisma enum so a group added to the schema is
 * covered here the day it lands; `enum-parity.spec.ts` pins the shared client mirror to the same set.
 */
export const ALL_PERMISSION_GROUPS: readonly OperatorPermissionGroup[] =
  Object.values(OperatorPermissionGroup);

/** The minimal principal the predicate needs (a JwtPayload satisfies it). */
export interface PermissionPrincipal {
  sub: string;
  tenantId: string | null;
  role: UserRole;
}

export interface EffectivePermissions {
  groups: OperatorPermissionGroup[];
  version: number;
}

/**
 * The groups an operator holds, from the groups an admin switched OFF: every group minus the denied
 * ones, in display order. An empty or missing deny list means every group. Unknown values in the input
 * are ignored (they can never be added to the result).
 */
export function groupsFromDenied(
  denied: readonly OperatorPermissionGroup[] | null | undefined,
): OperatorPermissionGroup[] {
  const off = new Set(denied ?? []);
  return ALL_PERMISSION_GROUPS.filter((group) => !off.has(group));
}

/**
 * The one predicate for "which feature groups does this principal hold". Reports only in this release:
 * nothing calls it to refuse a request.
 *
 *   TENANT_ADMIN / SUPER_ADMIN -> every group, version 0, no database read.
 *   OPERATOR                   -> every group minus the row's `deniedPermissionGroups`.
 *   anyone else                -> none.
 */
@Injectable()
export class OperatorPermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async effective(user: PermissionPrincipal): Promise<EffectivePermissions> {
    if (user.role === UserRole.TENANT_ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return { groups: [...ALL_PERMISSION_GROUPS], version: 0 };
    }
    if (user.role !== UserRole.OPERATOR || !user.tenantId) {
      return { groups: [], version: 0 };
    }
    // The BASE client with an explicit tenant: the request's tenant context may not be set yet where this
    // runs (guards run before it), so the query never relies on it.
    const row = await this.prisma.user.findFirst({
      where: { id: user.sub, tenantId: user.tenantId, deletedAt: null },
      select: { deniedPermissionGroups: true, permissionsVersion: true },
    });
    if (!row) return { groups: [], version: 0 };
    return {
      groups: groupsFromDenied(row.deniedPermissionGroups),
      version: row.permissionsVersion,
    };
  }

  /** The `GET /users/me/permissions` payload for the caller. */
  async mine(user: PermissionPrincipal): Promise<MyPermissions> {
    const { groups, version } = await this.effective(user);
    return {
      role: user.role,
      isAccountAdmin: user.role === UserRole.TENANT_ADMIN || user.role === UserRole.SUPER_ADMIN,
      groups,
      version,
      mode: PERMISSIONS_MODE,
    };
  }
}
