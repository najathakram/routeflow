import type { FlagKey } from "@routeflow/types";
import { useSubscription } from "./billing";

/** Same shape as `lib/plan-gated-nav.ts`'s `PlanFlagState` — kept structurally identical
 *  (not re-exported from there) so this stays a pure `lib/api` hook with no dependency on
 *  a UI-nav-specific module. */
export interface PlanFlagState {
  enabled: boolean;
  resolved: boolean;
  failed: boolean;
}

/**
 * Lite-L2 (WP7): does the tenant's current plan+addons grant `key`? Backed by the same
 * `useSubscription` query every other billing surface reads (react-query dedupes on
 * queryKey, so this never fires a second request alongside e.g. the dashboard shell's own
 * call). `resolved`/`failed` mirror `lib/api/addons.ts`'s `useDeveloperMode` contract: a
 * caller that can strand a user (a route guard) must key off `resolved`, never a bare
 * `!enabled`, and fail OPEN while the answer is unknown.
 */
export function usePlanFlag(key: FlagKey, opts?: { enabled?: boolean }): PlanFlagState {
  const q = useSubscription({ staleTime: 60_000, ...opts });
  return {
    enabled: q.data?.flags?.includes(key) ?? false,
    resolved: q.isSuccess,
    failed: q.isError,
  };
}
