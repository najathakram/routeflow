import type { OperatorPermissionGroup } from "@prisma/client";
import type { PermissionsMode } from "@routeflow/types";
import { staffMay } from "./staff-capabilities";

/**
 * The two `staffMay(…, "EDIT_LINE_PRICE", …)` answers behind every price-edit decision (SA-1034), and nothing else calls
 * `staffMay` for this capability: `priceEditAllowedFor` (the server's check) and `priceEditReported` (what
 * `GET /users/me/permissions` tells the web) both build on these, so the screen and the server can never read the rule
 * two ways.
 */

/** The role alone may type a line price (OPERATOR, TENANT_ADMIN), whatever the account's admin switched off. */
export const roleMayEditPrice = (role: string | null | undefined): boolean =>
  staffMay(role, "EDIT_LINE_PRICE", []);

/** The role may, and an OPERATOR's denied groups do not include PRICING. */
export const mayEditPrice = (
  role: string | null | undefined,
  deniedGroups: readonly string[],
): boolean => staffMay(role, "EDIT_LINE_PRICE", deniedGroups);

/**
 * What the web is told: the MODE-APPLIED answer, from the groups the caller HOLDS. `live` enforces the denials;
 * `shadow` reports the role-only answer, exactly as `priceEditAllowedFor` decides in each mode.
 */
export function priceEditReported(
  role: string | null | undefined,
  heldGroups: readonly OperatorPermissionGroup[],
  allGroups: readonly OperatorPermissionGroup[],
  mode: PermissionsMode,
): boolean {
  if (!roleMayEditPrice(role)) return false;
  if (mode !== "live") return true;
  return mayEditPrice(
    role,
    allGroups.filter((g) => !heldGroups.includes(g)),
  );
}
