import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { MarginConfig } from "@routeflow/types";
export type { MarginConfig } from "@routeflow/types";

export function useMarginConfig() {
  return useQuery<MarginConfig>({
    queryKey: ["margin-config"],
    queryFn: () => apiClient.get("/settings/margin").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/** Effective floor for a product category: per-category override, else the default. */
export function floorForCategory(cfg: MarginConfig | undefined, category?: string | null): number {
  if (!cfg) return 0.15;
  if (category && cfg.categoryFloors[category] != null) return cfg.categoryFloors[category];
  return cfg.defaultMarginFloor;
}
