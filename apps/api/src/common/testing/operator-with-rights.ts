import type { OperatorPermissionGroup } from "@prisma/client";

/** What the permissions read selects from the user row (`OperatorPermissionsService.effective`). */
const DENIED_COLUMN = "deniedPermissionGroups";

/** The groups an operator is denied out of the box (SA-1050: BAD_DEBT is the first group denied by default). */
export const DEFAULT_DENIED_GROUPS: OperatorPermissionGroup[] = ["BAD_DEBT"];

interface UserFindFirstMock {
  user: { findFirst: jest.Mock };
}

/**
 * An OPERATOR principal that holds its default permission groups, for a spec that is NOT about permissions
 * (W-870: a principal with no user row, or no tenant, now holds no right, so an operator built only as scenery
 * needs an explicit one). Opt-in per suite: the suite passes its own mocked prisma and its own principal.
 *
 * The REAL answer still runs (`priceEditAllowedFor` -> `operatorDeniedGroups` -> `effective`); this only gives
 * it the user row it reads. A read of the permission columns gets `{ deniedPermissionGroups: denied }`; every
 * other `user.findFirst` call falls through to whatever the suite already mocked. The principal comes back with
 * a tenant (the one it had, else `t-1`) and is otherwise unchanged, so the suite's own assertions still hold.
 */
export function operatorWithRights<P extends { tenantId?: string | null }>(
  prisma: UserFindFirstMock,
  principal: P,
  denied: OperatorPermissionGroup[] = DEFAULT_DENIED_GROUPS,
): P & { tenantId: string } {
  const previous = prisma.user.findFirst.getMockImplementation();
  prisma.user.findFirst.mockImplementation((args?: { select?: Record<string, unknown> }) =>
    args?.select && DENIED_COLUMN in args.select
      ? Promise.resolve({ deniedPermissionGroups: denied, permissionsVersion: 1 })
      : previous
        ? previous(args)
        : Promise.resolve(null),
  );
  // The suite keeps passing its own principal object to the service, so the tenant is stamped in place
  // when the fixture has none (a fixture-only write: the suite's other fields are untouched).
  const stamped = principal as P & { tenantId: string };
  if (stamped.tenantId == null) stamped.tenantId = "t-1";
  return stamped;
}
