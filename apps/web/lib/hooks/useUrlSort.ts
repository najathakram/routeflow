"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";

export type SortDir = "asc" | "desc";

/**
 * List sort (column + direction) that survives drilling into a row and pressing
 * Back, and a reload: the sort half of the Back-nav set whose search, filter and
 * page halves are `useUrlSearch`, `useUrlFilters` and `useUrlPage`.
 *
 * The value is DERIVED from `?sort=` / `?dir=`, never held in component state,
 * so it cannot be lost when the list unmounts. The default sort is the ABSENCE
 * of both params, and a column that is not in `allowed` reads as the default,
 * so a hand-edited or stale link cannot sort by a key the page does not know.
 *
 * Writes use a shallow `history.replaceState` built from the live query string,
 * for the reasons `useUrlSearch` documents (one history entry, never cancels an
 * in-flight `router.push`, never resurrects a param another writer removed).
 * `page` is left alone: these lists sort the rows of the page on screen, so a
 * new sort must not throw the operator back to page 1.
 */
export function useUrlSort<C extends string>(
  allowed: readonly C[],
  defaultCol: C,
  defaultDir: SortDir,
): [C, SortDir, (col: string, dir: SortDir) => void] {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const rawCol = searchParams.get("sort");
  const known = rawCol !== null && (allowed as readonly string[]).includes(rawCol);
  const col = known ? (rawCol as C) : defaultCol;
  const rawDir = searchParams.get("dir");
  const dir: SortDir = known && (rawDir === "asc" || rawDir === "desc") ? rawDir : defaultDir;

  const setSort = React.useCallback(
    (nextCol: string, nextDir: SortDir) => {
      const params = new URLSearchParams(window.location.search);
      const before = params.toString();
      const isDefault =
        !(allowed as readonly string[]).includes(nextCol) ||
        (nextCol === defaultCol && nextDir === defaultDir);
      if (isDefault) {
        params.delete("sort");
        params.delete("dir");
      } else {
        params.set("sort", nextCol);
        params.set("dir", nextDir);
      }
      const qs = params.toString();
      if (qs === before) return;
      window.history.replaceState(window.history.state, "", qs ? `${pathname}?${qs}` : pathname);
    },
    // `allowed` is a module-level constant at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, defaultCol, defaultDir],
  );

  return [col, dir, setSort];
}
