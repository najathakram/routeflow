import { useQuery } from "@tanstack/react-query";
import type { TenantFeaturesResponse } from "@routeflow/types";
import { apiClient } from "./api-client";
import { getTenantCookie } from "./tenant-cookie";

/**
 * Feature grants v2 brief A (design 2026-09-17 §2): `GET /tenants/me/features` — the
 * server-computed shadow resolver + old-path trace. NOT yet a client gating read path
 * (Opus review of 9923b87c, item 1: `usePlanFlag`/nav gates stay on `useSubscription()` —
 * see `lib/api/plan-flags.ts`); this hook exists for a future PR that revisits the switch,
 * and for any admin/debug surface that wants the raw served/resolver trace directly.
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
