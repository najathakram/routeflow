import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import type { ProductInsightsResponse, ProductSalesPage } from "@routeflow/types";
import { apiClient } from "../api-client";

/**
 * #2119 — product sales insights (plan §B / 2105-b), from #2179's
 * `GET /analytics/products/:id/insights`, `/sales` and `/insights.csv`
 * (apps/api/src/sales-facts/). Every figure is ACCRUAL NET — invoices by issue day minus
 * credits attributed to this product's lines on their own day — computed server-side; this
 * module never re-derives money.
 */

const clean = (p: Record<string, string | number | undefined>) =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => v != null && v !== ""));

export function useProductInsights(
  productId: string | null | undefined,
  params: { from?: string },
) {
  return useQuery<ProductInsightsResponse>({
    // Under ["products", id] so a product invalidation sweeps it too.
    queryKey: ["products", productId, "insights", params],
    queryFn: () =>
      apiClient
        .get(`/analytics/products/${productId}/insights`, { params: clean(params) })
        .then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Sold lines newest first, paged by LINE with the server's opaque cursor. */
export function useProductSalesLines(
  productId: string | null | undefined,
  params: { from?: string; to?: string; customerId?: string },
  opts: { enabled?: boolean } = {},
) {
  return useInfiniteQuery<ProductSalesPage>({
    queryKey: ["products", productId, "insights", "lines", params],
    queryFn: ({ pageParam }) =>
      apiClient
        .get(`/analytics/products/${productId}/sales`, {
          params: clean({
            ...params,
            cursor: (pageParam as string | undefined) ?? undefined,
            limit: 50,
          }),
        })
        .then((r) => r.data),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!productId && (opts.enabled ?? true),
    staleTime: 60_000,
  });
}

/** Downloads the window's lines + totals footer as a CSV file. */
export function useExportProductInsightsCsv() {
  return useMutation({
    mutationFn: async ({
      productId,
      from,
      to,
      customerId,
      filename,
    }: {
      productId: string;
      from?: string;
      to?: string;
      customerId?: string;
      filename: string;
    }) => {
      const res = await apiClient.get(`/analytics/products/${productId}/insights.csv`, {
        params: clean({ from, to, customerId }),
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}
