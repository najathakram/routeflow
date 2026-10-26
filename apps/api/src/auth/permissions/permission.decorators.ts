import { SetMetadata } from "@nestjs/common";
import type { OperatorPermissionGroup } from "@prisma/client";

/** Handler (or class) metadata: the permission groups, ANY of which opens it to an OPERATOR. */
export const PERMISSION_KEY = "requirePermission";
/** Handler (or class) metadata: reachable by any OPERATOR on purpose (a lookup other areas need), with the reason. */
export const PERMISSION_BASE_KEY = "permissionBase";

/**
 * Operator feature access (spec-operator-permissions §4.1): an OPERATOR reaches the handler only if the admin has
 * not switched off ALL of the named groups (any-of). Method metadata overrides class metadata, like `@Roles`.
 * TENANT_ADMIN, SUPER_ADMIN, DRIVER and CUSTOMER principals are never permission-checked.
 */
export const RequirePermission = (...groups: OperatorPermissionGroup[]) =>
  SetMetadata(PERMISSION_KEY, groups);

/**
 * Marks a handler reachable by any OPERATOR with NO group, on purpose (a cross-cutting lookup, e.g. the product picker
 * order entry needs). `reason` is a required string literal, so the exception is explained where it is made.
 */
export const PermissionBase = (reason: string) => SetMetadata(PERMISSION_BASE_KEY, reason);
