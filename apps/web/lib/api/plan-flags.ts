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
 * Lite-L2 (WP7): does the tenant's current subscription grant `key`? Backed by
 * `useSubscription().flags` (`GET /billing/subscription`) — feature grants v2's
 * server-computed `/tenants/me/features` (design 2026-09-17 §2) exists but is not yet a
 * client read path (Opus review of 9923b87c, item 1: the client switch reintroduces
 * P0-class risk — see entitlement-authority.service.ts's `served` field for the parity
 * proof this endpoint keeps for when a future PR revisits the switch).
 * `resolved`/`failed` mirror `lib/api/addons.ts`'s `useDeveloperMode` contract: a caller
 * that can strand a user (a route guard) must key off `resolved`, never a bare `!enabled`,
 * and fail OPEN while the answer is unknown.
 */
export function usePlanFlag(key: FlagKey, opts?: { enabled?: boolean }): PlanFlagState {
  const q = useSubscription(opts);
  return {
    enabled: q.data?.flags === undefined ? true : q.data.flags.includes(key),
    resolved: q.isSuccess,
    failed: q.isError,
  };
}
