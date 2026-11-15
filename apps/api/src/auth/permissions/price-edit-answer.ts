import type { OperatorPermissionGroup } from "@prisma/client";
import { staffMay } from "./staff-capabilities";

/**
 * The `staffMay(…, "EDIT_LINE_PRICE", …)` answer behind every price-edit decision (SA-1034, W-870), and nothing else
 * calls `staffMay` for this capability: `priceEditAllowedFor` (the server's check) and `priceEditReported` (what
 * `GET /users/me/permissions` tells the web) both build on it, so the screen and the server can never read the rule
 * two ways. It enforces the deny list at every site; the global permissions mode is not an input.
 */

/** The role may, and an OPERATOR's denied groups do not include PRICING. */
export const mayEditPrice = (
  role: string | null | undefined,
  deniedGroups: readonly string[],
): boolean => staffMay(role, "EDIT_LINE_PRICE", deniedGroups);

/**
 * What the web is told: the answer from the groups the caller HOLDS (the denied groups are every group not held),
 * exactly as `priceEditAllowedFor` decides.
 */
export function priceEditReported(
  role: string | null | undefined,
  heldGroups: readonly OperatorPermissionGroup[],
  allGroups: readonly OperatorPermissionGroup[],
): boolean {
  return mayEditPrice(
    role,
    allGroups.filter((g) => !heldGroups.includes(g)),
  );
}
