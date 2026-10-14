import type { RestrictionsPolicy } from "@routeflow/types";

/**
 * SA cross-row ruling (row 509 PR3 / row 510): does a rule change reach the STAFF channel? The ONE place an edit's
 * direction, impact and copy ask it. Row 510 (staff warnings with an override) made it ALWAYS true: the tenant switch
 * is gone and a staff sale is judged by every rule (a staff member with a reason may override the warning). Never
 * hard-code a "staff are not affected" branch anywhere else; the function keeps its `policy` parameter so the callers stay unchanged.
 */
export function staffChannelJudged(_policy?: RestrictionsPolicy): boolean {
  return true;
}
