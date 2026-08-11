/**
 * The one place the catalogue-picker search behaviour lives.
 *
 * Before this hook, every builder screen hand-rolled the same call — five
 * copies of `limit: 0`, five different justifying comments (two of them wrong
 * by the time they were read), no debounce anywhere, and an unused
 * `use-debounce.ts` sitting in this directory with zero importers. Putting the
 * debounce, the page size, the `keepPreviousData` and the
 * term-suppresses-category rule behind one import is what stops that drift.
 *
 * Screens keep their own cart/pinning/scan logic — that part is genuinely
 * screen-specific and does not belong here.
 */
import { useMemo, useState } from "react";
import { useDebounce } from "./use-debounce";
import { flattenPages } from "./paged-rows";
import { productSearchParams } from "./product-search-params";
import { PRODUCT_PAGE_SIZE, useProductsInfinite } from "./api/products";

/**
 * 250ms. Web's pickers use 300; a phone operator is standing at a stop with the
 * customer waiting, so the perceived-latency budget is tighter.
 */
export const PRODUCT_SEARCH_DEBOUNCE_MS = 250;

export interface ProductSearch<T> {
  /** Raw input value — bind this to the SearchBar. */
  search: string;
  setSearch: (s: string) => void;
  /** Trimmed raw term. Updates immediately, unlike the query. */
  searchTerm: string;
  products: T[];
  isLoading: boolean;
  /**
   * From the first keystroke until the matching page lands. Drives the inline
   * spinner and suppresses the "add as unlisted" CTA, so neither reacts to rows
   * that are about to be replaced.
   */
  isSearching: boolean;
  /**
   * The rows on screen belong to a PREVIOUS query key. Gate `onEndReached` on
   * this, or you fetch page N+1 of the new key on top of pages 1..N of the old.
   */
  isPlaceholder: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
}

export function useProductSearch<T extends { id: string }>(opts?: {
  category?: string;
  enabled?: boolean;
  limit?: number;
}): ProductSearch<T> {
  const [search, setSearch] = useState("");
  const searchTerm = search.trim();
  const debouncedTerm = useDebounce(searchTerm, PRODUCT_SEARCH_DEBOUNCE_MS);

  const query = useProductsInfinite(
    {
      ...productSearchParams({ term: debouncedTerm, category: opts?.category }),
      limit: opts?.limit ?? PRODUCT_PAGE_SIZE,
    },
    { enabled: opts?.enabled ?? true },
  );

  const products = useMemo(() => flattenPages<T>(query.data?.pages), [query.data]);

  return {
    search,
    setSearch,
    searchTerm,
    products,
    isLoading: query.isLoading,
    isSearching: searchTerm !== debouncedTerm || query.isFetching,
    isPlaceholder: query.isPlaceholderData,
    hasNextPage: !!query.hasNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
