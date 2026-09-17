import { useQuery } from "@tanstack/react-query";
import type { TenantFeaturesResponse } from "@routeflow/types";
import { apiClient } from "./api-client";
import { useAuthStore } from "./auth-store";
import { useTenantStore } from "./tenant-store";

/**
 * Feature grants v2 brief A (design 2026-09-17 §2): `GET /tenants/me/features` — the
 * server-computed effective feature set. The SINGLE read path for gated section/route
 * locking; no local flag list, no JWT claim. Mirrors web's `lib/tenant-features.ts`.
 */
export function useTenantFeatures() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const tenantSlug = useTenantStore((s) => s.slug);

  return useQuery<TenantFeaturesResponse>({
    queryKey: ["tenant", tenantSlug, "features"],
    queryFn: () => apiClient.get("/tenants/me/features").then((r) => r.data),
    staleTime: 60_000,
    retry: 2,
    enabled: isAuthenticated,
  });
}
