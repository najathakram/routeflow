import { OperatorPermissionGroup } from "@prisma/client";

/**
 * SA-1050 A-5: the groups an account starts without when it becomes an OPERATOR (owner 2026-10-20, "off by
 * default"). The column default stamps the same list on a NEW account and the data folder stamps it on the
 * operators that already existed; `updateUser` stamps it on an existing driver or customer moved to OPERATOR, so
 * no way in starts with a group the owner keeps off. One API literal, pinned equal to the OFF set of
 * `GROUP_INTRODUCED` in `permission-groups-contract.spec.ts`: the next OFF group is one registry row and one entry here.
 */
export const OPERATOR_DEFAULT_DENIED_GROUPS: readonly OperatorPermissionGroup[] = [
  OperatorPermissionGroup.BAD_DEBT,
];
