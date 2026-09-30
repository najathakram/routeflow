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
import { productSearchEnabled, productSearchParams } from "./product-search-params";
import { PRODUCT_PAGE_SIZE, useProductsInfinite } from "./api/products";
import { useAdminProductsInfinite } from "./api/admin";

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
  /**
   * The catalogue fetch is gated OFF: no term, not browsing. Render the idle
   * empty state, NOT "no products match" — nothing has been asked for yet.
   */
  idle: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
}

export interface ProductSearchOptions {
  category?: string;
  /** Hard off-switch for a closed picker. `false` wins over term and browse. */
  enabled?: boolean;
  /** The operator tapped "Browse catalogue" — load the list deliberately. */
  browsing?: boolean;
  limit?: number;
}

export function useProductSearch<T extends { id: string }>(
  opts?: ProductSearchOptions,
): ProductSearch<T> {
  const [search, setSearch] = useState("");
  const searchTerm = search.trim();
  const debouncedTerm = useDebounce(searchTerm, PRODUCT_SEARCH_DEBOUNCE_MS);
  const fetchEnabled = productSearchEnabled({
    term: debouncedTerm,
    browsing: opts?.browsing,
    enabled: opts?.enabled,
  });

  const query = useProductsInfinite(
    {
      ...productSearchParams({ term: debouncedTerm, category: opts?.category }),
      limit: opts?.limit ?? PRODUCT_PAGE_SIZE,
    },
    { enabled: fetchEnabled },
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
    idle: !fetchEnabled,
    hasNextPage: !!query.hasNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

/**
 * Sibling of `useProductSearch` for the AdminProduct-shaped pickers
 * (`ProductPickerSheet` and its 11 call sites). Built on
 * `useAdminProductsInfinite` rather than `useProductsInfinite` because that
 * hook hardcodes `isActive: true` (api/products.ts) while several
 * ProductPickerSheet callers (stock-count, PO-receive, vendor-bill-scan,
 * variant-parent pickers) legitimately need archived rows — the whole point
 * of the `activeOnly` prop pinned by product-picker-active.test.ts. Routing
 * them through useProductSearch would silently re-break B142 in the other
 * direction.
 */
export function useAdminProductSearch<T extends { id: string }>(opts?: {
  enabled?: boolean;
  browsing?: boolean;
  /** `true` excludes archived rows; `undefined` keeps the unfiltered catalog. */
  isActive?: boolean;
  limit?: number;
}): ProductSearch<T> {
  const [search, setSearch] = useState("");
  const searchTerm = search.trim();
  const debouncedTerm = useDebounce(searchTerm, PRODUCT_SEARCH_DEBOUNCE_MS);
  const fetchEnabled = productSearchEnabled({
    term: debouncedTerm,
    browsing: opts?.browsing,
    enabled: opts?.enabled,
  });

  const query = useAdminProductsInfinite(
    {
      search: debouncedTerm || undefined,
      isActive: opts?.isActive,
      limit: opts?.limit ?? PRODUCT_PAGE_SIZE,
    },
    { enabled: fetchEnabled },
  );

  // useAdminProductsInfinite's pages are typed `{ data: AdminProduct[] }`, not
  // the generic `T` this hook is declared with (callers pass a concrete
  // AdminProduct-shaped T, e.g. `useAdminProductSearch<AdminProduct>`), so TS
  // cannot prove `AdminProduct[]` is assignable to an arbitrary `T[]` on its
  // own — the cast documents that the caller's T IS that shape at runtime.
  const products = useMemo(
    () => flattenPages<T>(query.data?.pages as Array<{ data: T[] }> | undefined),
    [query.data],
  );

  return {
    search,
    setSearch,
    searchTerm,
    products,
    isLoading: query.isLoading,
    isSearching: searchTerm !== debouncedTerm || query.isFetching,
    isPlaceholder: query.isPlaceholderData,
    idle: !fetchEnabled,
    hasNextPage: !!query.hasNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
