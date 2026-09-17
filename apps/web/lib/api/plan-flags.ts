import type { FlagKey } from "@routeflow/types";
import { useTenantFeatures } from "../tenant-features";

/** Same shape as `lib/plan-gated-nav.ts`'s `PlanFlagState` — kept structurally identical
 *  (not re-exported from there) so this stays a pure `lib/api` hook with no dependency on
 *  a UI-nav-specific module. */
export interface PlanFlagState {
  enabled: boolean;
  resolved: boolean;
  failed: boolean;
}

/**
 * Lite-L2 (WP7); feature grants v2 brief A (design 2026-09-17 §2): does the tenant's
 * server-computed effective set grant `key`? Backed by `GET /tenants/me/features`
 * (react-query dedupes on queryKey) instead of `useSubscription().flags` — the single
 * server-computed source, not a local list or JWT claim. `resolved`/`failed` mirror
 * `lib/api/addons.ts`'s `useDeveloperMode` contract: a caller that can strand a user (a
 * route guard) must key off `resolved`, never a bare `!enabled`, and fail OPEN while the
 * answer is unknown.
 */
export function usePlanFlag(key: FlagKey, opts?: { enabled?: boolean }): PlanFlagState {
  const q = useTenantFeatures(opts);
  return {
    enabled: q.data?.effective === undefined ? true : q.data.effective.includes(key),
    resolved: q.isSuccess,
    failed: q.isError,
  };
}
