import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { CostHistoryEntry } from "@routeflow/types";
export type { CostHistoryEntry } from "@routeflow/types";

export function useCostHistory(productId: string | null | undefined) {
  return useQuery<CostHistoryEntry[]>({
    queryKey: ["products", productId, "cost-history"],
    queryFn: () => apiClient.get(`/analytics/cost-history/${productId}`).then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
  });
}
