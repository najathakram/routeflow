import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Cost history for a product (pos-cost-roles-spec §1) — the bills/lots behind the
 * live cost number. Backed by `GET /analytics/cost-history/:productId`, which
 * returns each PURCHASE / COST_BASIS movement with the running average after it.
 * Mirror of apps/web/lib/api/cost-history.ts.
 */
export interface CostHistoryEntry {
  date: string;
  unitCost: number;
  avgCostAfter: number | null;
  type: string; // StockMovement type — PURCHASE, COST_BASIS, etc.
}

export function useCostHistory(productId: string | null | undefined) {
  return useQuery<CostHistoryEntry[]>({
    queryKey: ["products", productId, "cost-history"],
    queryFn: () => apiClient.get(`/analytics/cost-history/${productId}`).then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
  });
}
