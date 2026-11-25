"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { UrlParamsWriter } from "./useUrlFilters";

export type SortDir = "asc" | "desc";

/** The two query params a sort lives in. A handler that clears the sort with other params deletes these. */
export const SORT_PARAM_KEYS = ["sort", "dir"] as const;

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
 * ONE URL WRITER PER PAGE. A page that also uses `useUrlFilters` MUST pass that
 * hook's `writeParams` as `write`: the sort then goes out on the same
 * `router.replace` path as the filters, builds on a filter write still on its
 * way, and a handler that changes filters and sort together does it in one
 * write. (Mixing the two mechanisms in one handler dropped the filter write:
 * Next discards a pending `replace` when a `replaceState` lands beside it.)
 * A page with no filter hook omits `write` and gets a shallow
 * `history.replaceState` built from the live query string, as `useUrlSearch`
 * does. `page` is left alone: these lists sort the rows of the page on screen, so a
 * new sort must not throw the operator back to page 1.
 */
export function useUrlSort<C extends string>(
  allowed: readonly C[],
  defaultCol: C,
  defaultDir: SortDir,
  write?: UrlParamsWriter,
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
      const isDefault =
        !(allowed as readonly string[]).includes(nextCol) ||
        (nextCol === defaultCol && nextDir === defaultDir);
      const apply = (params: URLSearchParams) => {
        if (isDefault) {
          for (const key of SORT_PARAM_KEYS) params.delete(key);
        } else {
          params.set("sort", nextCol);
          params.set("dir", nextDir);
        }
      };
      if (write) {
        write(apply, { keepPage: true });
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const before = params.toString();
      apply(params);
      const qs = params.toString();
      if (qs === before) return;
      window.history.replaceState(window.history.state, "", qs ? `${pathname}?${qs}` : pathname);
    },
    // `allowed` is a module-level constant at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, defaultCol, defaultDir, write],
  );

  return [col, dir, setSort];
}
