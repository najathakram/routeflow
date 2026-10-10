import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { DemandRange, ProductDemand } from "@routeflow/types";
import { apiClient } from "../api-client";

/**
 * Per-product demand series for the product-detail chart.
 * Backed by `GET /analytics/demand/:productId?range=` — see
 * `apps/api/src/analytics/analytics.service.ts getProductDemand`.
 *
 * The payload carries BOTH units and revenue, so the card's metric toggle is pure
 * client state and never refetches — only `range` is a server concern.
 * The DTO lives in `@routeflow/types` (shared with mobile); re-exported for callers.
 */
export type { DemandRange, DemandGranularity, DemandBucket, ProductDemand } from "@routeflow/types";

export function useProductDemand(productId: string | null | undefined, range: DemandRange) {
  return useQuery<ProductDemand>({
    // `range` is part of the key so each window caches independently; the
    // ["products", id, …] prefix means a blanket product invalidation sweeps it too.
    queryKey: ["products", productId, "demand", range],
    queryFn: () =>
      apiClient.get(`/analytics/demand/${productId}`, { params: { range } }).then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
    // Hold the previous range's bars while the next one loads, instead of collapsing
    // to a skeleton on every toggle click.
    placeholderData: keepPreviousData,
  });
}
