import type { RestrictionsPolicy } from "@routeflow/types";
import { restrictionsApply } from "../selling-restrictions/selling-restrictions.core";

/**
 * SA cross-row ruling (row 509 PR3 / row 510): does a rule change reach the STAFF channel? The ONE place an edit's
 * direction, impact and copy ask it. Today it is the tenant switch (`selling_restrictions.enabled`, read through
 * `restrictionsApply`); row 510 (staff warnings with an override) makes it always true — change it HERE only, and
 * never hard-code "staff unaffected" anywhere else.
 */
export function staffChannelJudged(policy: RestrictionsPolicy): boolean {
  return restrictionsApply(policy, "STAFF");
}
