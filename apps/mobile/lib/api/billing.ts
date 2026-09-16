import { useQuery } from "@tanstack/react-query";
import type { FlagKey, SubscriptionView } from "@routeflow/types";
import { apiClient } from "../api-client";
import { useAuthStore } from "../auth-store";
import { useTenantStore } from "../tenant-store";

// ─── Subscription (Lite-L2, WP11) ──────────────────────────────────────────────
//
// Mirrors lib/api/addons.ts's useDeveloperMode fetch pattern: tenant-scoped query key
// (so signing out of one tenant and into another on the same device never hands the
// next session a stale answer for the rest of the staleTime), gated on `enabled:
// isAuthenticated` (pre-auth screens mount before a token exists), and a retry budget
// — this read is load-bearing for section-locking below, so it is not `retry: false`.
export function useSubscription() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenantSlug = useTenantStore((s) => s.slug);

  return useQuery<SubscriptionView>({
    queryKey: ["tenant", tenantSlug, "subscription"],
    queryFn: () => apiClient.get("/billing/subscription").then((r) => r.data),
    staleTime: 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });
}

/**
 * Does the tenant's current plan+addons grant `key`? `resolved`/`failed` follow the
 * same contract as useDeveloperMode/useDriverPayments/useRoutesAccess: `resolved` says
 * the flag was actually READ (not just "not loading"), and any caller that can strand a
 * user (the operator section lock, `planLockedSection`) must key off `resolved`, never a
 * bare `!enabled`, and fail OPEN while the answer is unknown.
 */
export function usePlanFlag(key: FlagKey): {
  enabled: boolean;
  resolved: boolean;
  failed: boolean;
} {
  const q = useSubscription();
  return {
    enabled: q.data?.flags?.includes(key) ?? false,
    resolved: q.isSuccess,
    failed: q.isError,
  };
}
