"use client";

import type { FlagKey } from "@routeflow/types";
import { usePlanFlag } from "@/lib/api/plan-flags";

/**
 * The plan-flag key for the redesigned accumulating scan screen. It is a RequirePlanFlag-gated key
 * in the API's feature registry, ENFORCED-BUT-UNGRANTED: no plan bundles it, so it is off for every
 * tenant until the owner adds an override GRANT (feature grants) for that tenant. It is not a member
 * of the shared `FLAG_KEYS` tuple (that tuple is the courtesy-allowed set), hence the cast.
 */
export const SCAN_V2_FLAG = "flag.scan_v2" as FlagKey;

/**
 * Is the new scan screen on for this tenant? DARK by default: `usePlanFlag` reports `enabled: true`
 * while the subscription is still loading (it fails open, correct for a route guard that must not
 * strand a user), which is exactly wrong for an opt-in UI — so this requires the answer to be
 * `resolved` as well. Loading, an error, or a flag not in the list all read as OFF.
 */
export function useScanV2Enabled(): boolean {
  const flag = usePlanFlag(SCAN_V2_FLAG);
  return flag.resolved && flag.enabled;
}
