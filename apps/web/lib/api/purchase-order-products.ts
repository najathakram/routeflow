import { useQueries } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * The products a purchase order's own lines point at, read by id (`GET /products/:id`, which
 * includes the parent so a variant still names as "<Parent> - <Variant>").
 *
 * The PO detail screen only needs these rows (pack size for the lines table, names for the
 * receive modal), never the tenant's whole catalog. Uses the same ["products", id] query key as
 * `useProduct`, so a product already read elsewhere is served from cache.
 */
export function useProductsByIds(ids: readonly string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: ["products", id],
      queryFn: () => apiClient.get(`/products/${id}`).then((r) => r.data),
    })),
  });
  return {
    // Rows that have landed, in the order the ids were given; a failed or pending id is skipped.
    data: results.flatMap((r) => (r.data ? [r.data] : [])) as any[],
    isLoading: results.some((r) => r.isLoading),
  };
}
