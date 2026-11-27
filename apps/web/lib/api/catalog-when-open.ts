import { useProducts } from "@/lib/api/products";

/**
 * The WHOLE catalog (`limit: 0`, up to 10,000 rows with a signed thumbnail each) for a popup that needs every product
 * at once. W-1413: it reads only while `isOpen` is true. A popup is mounted by its page even when closed, so an
 * ungated read downloaded the catalog on every page load and again after every product save (a mounted query is
 * "active", so `invalidateProductSet` refetched it). Disabled, the query is neither fetched nor refetched.
 * Every popup that needs the full list goes through here; a bare `useProducts({ limit: 0 })` in a popup is pinned out
 * by `components/popup-catalog-reads.test.tsx`.
 */
export function useCatalogWhenOpen(isOpen: boolean, params?: { isActive?: boolean }) {
  return useProducts({ ...params, limit: 0 }, { enabled: isOpen });
}
