import { useQuery } from "@tanstack/react-query";
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

export interface PriceHistoryResponse {
  customerId: string;
  customerName: string;
  productId: string;
  productName: string;
  /** False for a caller who may not see cost: every cost field is then null and the UI hides it. */
  costVisible: boolean;
  rows: PriceHistoryRow[];
  summaries: PriceHistorySummary[];
}

export function usePriceHistory(
  customerId: string | null | undefined,
  productId: string | null | undefined,
  enabled: boolean,
  limit = 25,
) {
  return useQuery<PriceHistoryResponse>({
    queryKey: ["customers", customerId, "products", productId, "price-history", limit],
    queryFn: () =>
      apiClient
        .get(`/customers/${customerId}/products/${productId}/price-history`, { params: { limit } })
        .then((r) => r.data),
    enabled: enabled && !!customerId && !!productId,
    staleTime: 30_000,
    retry: false,
  });
}
