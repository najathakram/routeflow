import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * GET /customers/:customerId/products/:productId/price-history — what THIS customer has paid for
 * THIS product (invoiced sales, plus open not-yet-invoiced orders, labelled separately). Staff only.
 *
 * The contract lives in `@routeflow/types` (`packages/types/api/price-history.ts`, builder D's PR);
 * these identical local types switch to that import once it lands.
 */
export type PriceHistorySource = "INVOICE" | "OPEN_ORDER";

export interface PriceHistoryRow {
  date: string;
  source: PriceHistorySource;
  unitPrice: number;
  unitLabel: string;
  unitsPerBox: number | null;
  qty: number;
  boxes: number | null;
  pieces: number | null;
  avgCostAtSale: number | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  orderId: string;
  orderNumber: string;
  priceType: string | null;
}

export interface PriceHistorySummary {
  unitLabel: string;
  last: number | null;
  low: number | null;
  high: number | null;
  qtySold: number;
  currentAvgCost: number | null;
}

export interface PriceHistoryReferences {
  listPrice: number | null;
  tierPrice: number | null;
  /** Fraction (0.03 = +3%) of the newest sale vs the one before; null with fewer than two. */
  changeSinceLast: number | null;
}

/** Other customers' prices for the product (never names): low / typical (median) / high. */
export interface PriceHistoryAggregate {
  low: number;
  median: number;
  high: number;
  customers: number;
  unitLabel: string;
}

export interface PriceHistoryResponse {
  customerId: string;
  customerName: string;
  productId: string;
  productName: string;
  /** False for a caller who may not see cost: every cost field is then null and the UI hides it. */
  costVisible: boolean;
  rows: PriceHistoryRow[];
  summaries: PriceHistorySummary[];
  /** v1.1 (builder F); absent until that API lands. */
  references?: PriceHistoryReferences;
  aggregate?: PriceHistoryAggregate | null;
}

export const priceHistoryKey = (
  customerId: string | null | undefined,
  productId: string | null | undefined,
  limit: number,
) => ["customers", customerId, "products", productId, "price-history", limit] as const;

const fetchPriceHistory = (customerId: string, productId: string, limit: number) =>
  apiClient
    .get(`/customers/${customerId}/products/${productId}/price-history`, { params: { limit } })
    .then((r) => r.data as PriceHistoryResponse);

export function usePriceHistory(
  customerId: string | null | undefined,
  productId: string | null | undefined,
  enabled: boolean,
  limit = 25,
) {
  return useQuery<PriceHistoryResponse>({
    queryKey: priceHistoryKey(customerId, productId, limit),
    queryFn: () => fetchPriceHistory(customerId!, productId!, limit),
    enabled: enabled && !!customerId && !!productId,
    staleTime: 30_000,
    retry: false,
  });
}

/** Warm the cache as soon as a customer + product are known, so the panel opens with no spinner. */
export function usePrefetchPriceHistory(
  customerId: string | null | undefined,
  productId: string | null | undefined,
  limit = 25,
) {
  const qc = useQueryClient();
  React.useEffect(() => {
    if (!customerId || !productId) return;
    void qc.prefetchQuery({
      queryKey: priceHistoryKey(customerId, productId, limit),
      queryFn: () => fetchPriceHistory(customerId, productId, limit),
      staleTime: 30_000,
    });
  }, [qc, customerId, productId, limit]);
}
