import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Tenant cost/margin config (pos-cost-roles-spec §1) — drives the order
 * builder's live cost/margin hint. Mirror of apps/web/lib/api/margin.ts.
 */
export interface MarginConfig {
  costingMethod: "WEIGHTED_AVERAGE" | "FIFO" | "LAST_COST";
  /** Default minimum margin as a fraction (0.15 = 15%). */
  defaultMarginFloor: number;
  /** Per-category floor overrides, keyed by Product.category. */
  categoryFloors: Record<string, number>;
}

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
