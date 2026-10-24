import { useQuery } from "@tanstack/react-query";
import type { TenantFeaturesResponse } from "@routeflow/types";
import { apiClient } from "./api-client";
import { getTenantCookie } from "./tenant-cookie";

/**
 * Feature grants v2 brief A (design 2026-09-17 §2): `GET /tenants/me/features` — the
 * server-computed shadow resolver + old-path trace. Plan-flag / nav gates stay on
 * `useSubscription()` (Opus review of 9923b87c, item 1; see `lib/api/plan-flags.ts`). It IS the read
 * path for `capabilities.fulfilment` (`lib/fulfilment-caps.ts`): the fulfilment pickers, status words and
 * the fleet-off surfaces (`useFleetAccess`) all read that one answer, never the raw modes.
 * Query key includes the tenant slug (item 4) so a stale answer from one tenant can never
 * leak into a session that has since switched tenants, mirroring mobile's
 * `lib/tenant-features.ts`.
 */
export function useTenantFeatures(options?: { staleTime?: number; enabled?: boolean }) {
  return useQuery<TenantFeaturesResponse>({
    queryKey: ["tenant", getTenantCookie(), "features"],
    queryFn: () => apiClient.get("/tenants/me/features").then((r) => r.data),
    staleTime: 60_000,
    ...options,
  });
}
