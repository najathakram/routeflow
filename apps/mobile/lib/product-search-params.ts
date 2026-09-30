/**
 * Pure query-shaping for the catalogue pickers. Extracted so the rules survive
 * the move from client-side filtering to server-side params — a `filter()` that
 * quietly disappears is exactly how these screens drifted before.
 */
import { looksLikeScanCode } from "./wedge-scan";

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProductSearchParams {
  search?: string;
  /**
   * Set instead of `search` when the term is scan-shaped (see
   * `looksLikeScanCode`). The server treats `search` and `scanCode` as
   * mutually exclusive (`products.service.ts` findAll: `if (query.search)
   * {...} else if (query.scanCode) {...}`) and expands `scanCode` against
   * every `normalizeScanCode` candidate rather than the literal string — a
   * plain ILIKE on `search` cannot match an iOS 13-digit decode against a
   * 12-digit stored UPC-A, so a wedge/typed scan code must go through this
   * field to actually resolve.
   */
  scanCode?: string;
  category?: string;
}

/**
 * Turn the screen's UI state into `/products` query params.
 *
 * The category chip row is HIDDEN while a search term is active, so a live term
 * must also drop the category — otherwise results stay narrowed behind a
 * control the operator can no longer see. That rule used to live inside the
 * client-side `filtered` memo; it lives here now.
 *
 * A scan-shaped term (see `looksLikeScanCode`) is sent as `scanCode` instead
 * of `search` — see the field doc above for why a literal `search` match is
 * insufficient for a scanned code.
 */
export function productSearchParams(input: {
  term?: string;
  category?: string;
}): ProductSearchParams {
  const term = input.term?.trim() || undefined;
  const category = term || !input.category || input.category === "All" ? undefined : input.category;
  if (term && looksLikeScanCode(term)) return { scanCode: term, category };
  return { search: term, category };
}

/** Next page number for an infinite query, or undefined at the end. */
export function nextProductPage(meta: PaginationMeta | undefined): number | undefined {
  if (!meta) return undefined;
  if (!Number.isFinite(meta.page) || !Number.isFinite(meta.totalPages)) return undefined;
  return meta.page < meta.totalPages ? meta.page + 1 : undefined;
}

/**
 * Owner ask (2026-09-14): the catalogue loads only when the operator asks for
 * it — a term (typed or wedge-scanned) or a deliberate "Browse catalogue" tap.
 * `enabled` stays a VETO, never a force: a closed picker passing
 * `enabled: false` must never fetch, and a picker passing `enabled: true`
 * still waits for a term or for browse.
 */
export function productSearchEnabled(input: {
  term?: string;
  browsing?: boolean;
  enabled?: boolean;
}): boolean {
  if (input.enabled === false) return false;
  return !!input.term?.trim() || input.browsing === true;
}
