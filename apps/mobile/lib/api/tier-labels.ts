import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Tenant-configured price-tier display names (e.g. "Wholesaler" for tier 2),
 * stored as one JSON document under SystemConfig key `pricing.tierLabels`.
 * Mirror of apps/web/lib/api/tier-labels.ts. Read-only here — mobile has no
 * editing UI for this config in this task; pair with `tierLabel()` from
 * `../tier-label` to resolve a display name with the "Tier N" fallback.
 */
export type TierLabels = Record<string, string>;

export function useTierLabels() {
  return useQuery<TierLabels>({
    queryKey: ["tier-labels"],
    queryFn: () => apiClient.get("/settings/pricing-tier-labels").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}
