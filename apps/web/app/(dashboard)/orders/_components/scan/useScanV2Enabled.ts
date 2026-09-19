"use client";

import type { FlagKey } from "@routeflow/types";
import { useSubscription } from "@/lib/api/billing";

/**
 * The plan-flag key for the redesigned accumulating scan screen. It is a RequirePlanFlag-gated key
 * in the API's feature registry, ENFORCED-BUT-UNGRANTED: no plan bundles it, so it is off for every
 * tenant until the owner adds an override GRANT (feature grants) for that tenant. It is not a member
 * of the shared `FLAG_KEYS` tuple (that tuple is the courtesy-allowed set), hence the cast.
 */
export const SCAN_V2_FLAG = "flag.scan_v2" as FlagKey;

/**
 * Is the new scan screen on for this tenant? DARK by default, and deliberately NOT built on
 * `usePlanFlag`: that hook fails OPEN (`enabled: true`) both while the subscription loads AND when a
 * successful response simply omits `flags` (the field is optional in the shared DTO — a web build
 * deployed ahead of the API, say). Right for a route guard that must never strand a user; exactly
 * wrong for an opt-in UI. So this is ON only for a resolved subscription whose `flags` is a real
 * array that contains the key. Loading, an error, a missing/odd `flags`, or a tenant that was never
 * granted all read as OFF.
 */
export function useScanV2Enabled(): boolean {
  const sub = useSubscription({ staleTime: 60_000 });
  const flags: unknown = sub.data?.flags;
  return sub.isSuccess && Array.isArray(flags) && flags.includes(SCAN_V2_FLAG);
}
