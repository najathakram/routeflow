import { useQuery } from "@tanstack/react-query";
import type { TenantFeaturesResponse } from "@routeflow/types";
import { apiClient } from "./api-client";

/**
 * Feature grants v2 brief A (design 2026-09-17 §2): `GET /tenants/me/features` — the
 * server-computed effective feature set. The SINGLE read path for gated nav/lock-wall UI;
 * no local FLAG_KEYS list, no JWT claim. Shadow mode makes zero enforcement change: this
 * endpoint returns exactly what SubscriptionService.getSubscription().flags already did for
 * every key it consulted, since EntitlementAuthority's shadow-mode decision is byte-identical
 * to the pre-PR one (see entitlement-authority.service.spec.ts's shadow-parity oracle).
 */
export function useTenantFeatures(options?: { staleTime?: number; enabled?: boolean }) {
  return useQuery<TenantFeaturesResponse>({
    queryKey: ["tenant-features"],
    queryFn: () => apiClient.get("/tenants/me/features").then((r) => r.data),
    staleTime: 60_000,
    ...options,
  });
}
