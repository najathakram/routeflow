import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { DemandRange, ProductDemand } from "@routeflow/types";
import { apiClient } from "../api-client";

export type { DemandRange, DemandGranularity, DemandBucket, ProductDemand } from "@routeflow/types";

/**
 * Per-product demand series — same endpoint and DTO as web's `useProductDemand`
 * (`GET /analytics/demand/:productId?range=`). The payload carries units AND revenue,
 * so the metric toggle is client state; only `range` is a server concern.
 * OPERATOR + `flag.analytics` gated server-side: a locked tenant gets 403 (callers hide
 * the card via `isDemandForbidden`).
 */
export function useProductDemand(productId: string | null | undefined, range: DemandRange) {
  return useQuery<ProductDemand>({
    queryKey: ["products", productId, "demand", range],
    queryFn: () =>
      apiClient.get(`/analytics/demand/${productId}`, { params: { range } }).then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
    retry: (count, err) => !isDemandForbidden(err) && count < 2,
    placeholderData: keepPreviousData,
  });
}

/** True for a 403 (plan-locked analytics or wrong role) — render nothing, never an error. */
export function isDemandForbidden(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 403;
}
