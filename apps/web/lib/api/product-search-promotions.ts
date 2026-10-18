import { useQueries } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { useDebounce } from "../hooks/useDebounce";
import { useProducts, type ApiProduct } from "./products";

/**
 * Reads for the promotion "Specific products" picker. The picker used to list the tenant's WHOLE catalog
 * (`useProducts({ limit: 0 })`) and filter it in the browser; it now asks the server for the few rows the
 * operator is looking at, and looks up the names of already-chosen products by id.
 */

/** Rows the picker asks for per search. The list shows at most this many; a longer term narrows it. */
export const PROMO_PICKER_LIMIT = 20;

const VARIANT_SEPARATOR = " - ";

/**
 * What the SERVER searches for. A variant is shown, and typed, as "<Parent> - <Variant>", but the server
 * matches a row's own name / SKU / barcode, so a composed term is narrowed to its last part (the variant
 * flavor). The picker still filters the returned rows by the full composed term.
 */
export function promoServerSearchTerm(term: string): string | undefined {
  const trimmed = term.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(VARIANT_SEPARATOR);
  const last = parts[parts.length - 1].trim();
  return last || trimmed;
}

/** The first page of products matching the (debounced) typed term; with no term, the first page of the catalog. */
export function usePromotionProductSearch(term: string) {
  const debounced = useDebounce(term, 250);
  return useProducts({ search: promoServerSearchTerm(debounced), limit: PROMO_PICKER_LIMIT });
}

/**
 * Products by id (one cached `GET /products/:id` each, the same cache entry `useProduct(id)` uses), for the
 * chips of products chosen earlier (editing a saved promotion). Ids in `skip` are not fetched: the picker
 * already holds those rows.
 */
export function usePromotionProductsByIds(
  ids: readonly string[],
  skip: ReadonlySet<string>,
): Map<string, ApiProduct> {
  const wanted = ids.filter((id) => !skip.has(id));
  const results = useQueries({
    queries: wanted.map((id) => ({
      queryKey: ["products", id],
      queryFn: () => apiClient.get(`/products/${id}`).then((r) => r.data as ApiProduct),
      staleTime: 60_000,
    })),
  });
  const out = new Map<string, ApiProduct>();
  results.forEach((r, i) => {
    if (r.data) out.set(wanted[i], r.data);
  });
  return out;
}
