import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Per-product demand series for the product-detail chart.
 * Backed by `GET /analytics/demand/:productId?range=` — see
 * `apps/api/src/analytics/analytics.service.ts getProductDemand`.
 *
 * The payload carries BOTH units and revenue, so the card's metric toggle is pure
 * client state and never refetches — only `range` is a server concern.
 */

export type DemandRange = "30d" | "6m" | "1y" | "5y";
export type DemandGranularity = "day" | "week" | "month";

export interface DemandBucket {
  /** Bucket START as a bare "YYYY-MM-DD". Never parse with `new Date()` — a date-only
   *  string parses as UTC midnight and renders as the previous day west of UTC. */
  date: string;
  /** Base units (pieces) invoiced in this bucket. 0 when nothing sold. */
  units: number;
  /** Net invoiced sales in this bucket (line subtotals, pre-tax). */
  revenue: number;
}

export interface ProductDemand {
  productId: string;
  range: DemandRange;
  /** Server-authoritative, so axis labels can never disagree with the bucketing. */
  granularity: DemandGranularity;
  from: string;
  to: string;
  /** EVERY bucket in the window, zero-filled, oldest → newest. */
  buckets: DemandBucket[];
  totals: { units: number; revenue: number };
  /** False ⇒ never invoiced at any date — "never sold", not "zero this window". */
  hasAnySales: boolean;
  firstSaleAt: string | null;
  lastSaleAt: string | null;
}

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
