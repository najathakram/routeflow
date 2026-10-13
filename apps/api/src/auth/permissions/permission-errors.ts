import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { OperatorPermissionGroup } from "@prisma/client";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * 403 for a caller that holds none of the feature groups an endpoint needs. `groups` lists the groups
 * that would have opened it; it never reveals anything about other users.
 */
export function permissionDeniedException(
  groups: readonly OperatorPermissionGroup[],
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: API_ERROR_CODES.PERMISSION_DENIED,
    message: "You do not have access to this feature. Ask your account admin.",
    groups: [...groups],
  });
}

/** 409 for a permissions write whose `expectedVersion` no longer matches the stored version. */
export function permissionsVersionConflictException(currentVersion: number): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: API_ERROR_CODES.PERMISSIONS_VERSION_CONFLICT,
    message: "This user's access was changed by someone else. Reload and try again.",
    version: currentVersion,
  });
}
