/**
 * Pure query-shaping for the catalogue pickers. Extracted so the rules survive
 * the move from client-side filtering to server-side params — a `filter()` that
 * quietly disappears is exactly how these screens drifted before.
 */

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProductSearchParams {
  search?: string;
  category?: string;
}

/**
 * Turn the screen's UI state into `/products` query params.
 *
 * The category chip row is HIDDEN while a search term is active, so a live term
 * must also drop the category — otherwise results stay narrowed behind a
 * control the operator can no longer see. That rule used to live inside the
 * client-side `filtered` memo; it lives here now.
 */
export function productSearchParams(input: {
  term?: string;
  category?: string;
}): ProductSearchParams {
  const term = input.term?.trim() || undefined;
  const category = term || !input.category || input.category === "All" ? undefined : input.category;
  return { search: term, category };
}

/** Next page number for an infinite query, or undefined at the end. */
export function nextProductPage(meta: PaginationMeta | undefined): number | undefined {
  if (!meta) return undefined;
  if (!Number.isFinite(meta.page) || !Number.isFinite(meta.totalPages)) return undefined;
  return meta.page < meta.totalPages ? meta.page + 1 : undefined;
}
