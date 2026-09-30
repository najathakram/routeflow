"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * List page-number that survives drilling into a row and pressing Back.
 *
 * Drop-in for the `const [page, setPage] = React.useState(1)` the list pages
 * declared: the value is DERIVED from `?page=` rather than held in component
 * state, so it can't be lost when the list unmounts on navigation, and setPage
 * mirrors it back into the URL. Opening a row pushes a new history entry, so
 * Back returns to the list entry with `?page=` still on it and the list renders
 * the same page the operator left — the page-position half of the Back-nav fix
 * whose search half shipped in #346 (`useUrlSearch`).
 *
 * Uses `router.replace`, never `push` — the list keeps ONE history entry, so
 * Back exits the list instead of walking page-by-page backwards.
 *
 * Page 1 is the ABSENCE of the param, matching `useUrlSearch`/`useUrlFilters`,
 * which both `delete("page")` when a search or filter re-ranks the list. Writes
 * rebuild the query from the live location, so a page write landing after a
 * filter chip can't resurrect params the chip removed.
 *
 * Pair with a filter-change "reset to page 1" effect that SKIPS its first run
 * (see products/page.tsx) — otherwise the mount-time reset clobbers the page
 * just restored from the URL.
 */
export function useUrlPage(
  key = "page",
): [number, (next: number | ((prev: number) => number)) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = parsePage(searchParams.get(key));

  const setPage = React.useCallback(
    (next: number | ((prev: number) => number)) => {
      // Read the live query string, not this render's snapshot, so the
      // functional-updater form sees the current page and a concurrent filter
      // write isn't clobbered (the stale-snapshot trap useUrlSearch documents).
      const params = new URLSearchParams(window.location.search);
      const prev = parsePage(params.get(key));
      const value = typeof next === "function" ? next(prev) : next;
      if (value > 1) params.set(key, String(value));
      else params.delete(key);
      const qs = params.toString();
      // Nothing to do if the page is already what was asked for. Without this,
      // a `setPage(1)` sitting in a per-keystroke handler fires a real history
      // write and router transition on EVERY keystroke — free when the page was
      // component state, not free now. It also keeps a redundant write from
      // racing a filter write landing in the same tick.
      if (qs === new URLSearchParams(window.location.search).toString()) return;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, key],
  );

  return [page, setPage];
}

function parsePage(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/**
 * Reset to page 1 when filter values actually CHANGE — the companion every
 * `useUrlPage` call site needs.
 *
 * The list pages used to do this with a bare `useEffect(() => setPage(1), [filters])`,
 * which is fine while the page lives in component state but destroys a URL-backed
 * page: the effect also fires on MOUNT, so landing on `/products?page=3` (or
 * pressing Back onto it) immediately reset to page 1.
 *
 * Comparing values, rather than skipping the first run with a ref, is what makes
 * this safe under React StrictMode: a `didMountRef` survives StrictMode's
 * mount → cleanup → mount, so the second run sees `true` and resets anyway,
 * clobbering the restored page in dev while working in prod. The serialized
 * values are identical across that double-invoke, so this stays put.
 *
 * `values` is serialized into a single dependency, so call sites pass an inline
 * array without tripping the exhaustive-deps rule.
 */
/**
 * Pull an out-of-range page back into range once the server reports how many
 * pages there actually are.
 *
 * A URL-backed page can outlive its data in a way component state never could:
 * press Back onto `?page=3` after rows were deleted, or open a shared/stale
 * link, and the list requests a page past the end. The API returns an empty
 * array with a truthy total, which reads as "no records yet" while the pager
 * (windowed around the current page) can render no usable buttons at all — the
 * operator is stranded on a page that does not exist.
 *
 * Pass the meta the list already has. `totalPages` of 0/undefined means "not
 * loaded yet" and is ignored, so this never fires against an in-flight query.
 */
export function useClampPage(
  setPage: (page: number) => void,
  page: number,
  totalPages: number | undefined,
): void {
  React.useEffect(() => {
    if (!totalPages || totalPages < 1) return; // unknown / still loading
    if (page <= totalPages) return;
    setPage(totalPages);
  }, [page, totalPages, setPage]);
}

export function useResetPageOnChange(setPage: (page: number) => void, values: unknown[]): void {
  const key = JSON.stringify(values);
  const prevKey = React.useRef<string | null>(null);

  React.useEffect(() => {
    // First observation: adopt it as the baseline. Nothing to reset *from*.
    if (prevKey.current === null) {
      prevKey.current = key;
      return;
    }
    if (prevKey.current === key) return; // re-run with unchanged filters
    prevKey.current = key;
    setPage(1);
  }, [key, setPage]);
}
