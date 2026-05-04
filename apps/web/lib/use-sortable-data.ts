"use client";

import * as React from "react";

export type SortDirection = "asc" | "desc";

/**
 * Lightweight client-side sort hook for raw `<table>` markup that doesn't use
 * the shared `<Table>` component (76+ tables across the dashboard, mostly
 * hand-written `<thead>`/`<tbody>`).
 *
 * Use together with `<SortableTh>` for the header cell:
 *
 *   const { sorted, sortKey, sortDir, requestSort } = useSortableData(items, {
 *     defaultKey: "name",
 *     defaultDir: "asc",
 *     // Optional override per key — default is `localeCompare` for strings,
 *     // numeric subtract for numbers/Date.
 *     comparators: { currentStock: (a, b) => Number(a.currentStock) - Number(b.currentStock) },
 *   });
 *
 *   <SortableTh name="name" current={sortKey} dir={sortDir} onSort={requestSort}>
 *     Product
 *   </SortableTh>
 *   …
 *   {sorted.map(row => …)}
 *
 * Click cycles asc → desc → unsorted (back to the input order). Stable on
 * equal keys (preserves original order). Pure JS — no dependency on TanStack.
 */
export interface UseSortableDataOptions<T> {
  defaultKey?: keyof T | string | null;
  defaultDir?: SortDirection;
  /** Per-key custom comparators. Receives raw rows. Return <0 / 0 / >0. */
  comparators?: Partial<Record<string, (a: T, b: T) => number>>;
  /** Per-key value extractor (e.g. nested `customer.name`). */
  accessors?: Partial<Record<string, (row: T) => unknown>>;
}

export interface UseSortableDataResult<T> {
  sorted: T[];
  sortKey: string | null;
  sortDir: SortDirection;
  requestSort: (key: string) => void;
  /** Reset sort to the default (or unsorted if no default was given). */
  reset: () => void;
}

export function useSortableData<T>(
  items: T[],
  opts: UseSortableDataOptions<T> = {},
): UseSortableDataResult<T> {
  const { defaultKey = null, defaultDir = "asc", comparators, accessors } = opts;

  const [sortKey, setSortKey] = React.useState<string | null>(
    defaultKey != null ? String(defaultKey) : null,
  );
  const [sortDir, setSortDir] = React.useState<SortDirection>(defaultDir);

  const requestSort = React.useCallback((key: string) => {
    setSortKey((current) => {
      if (current !== key) {
        // First click on a new column → asc.
        setSortDir("asc");
        return key;
      }
      // Same column clicked again → cycle asc → desc → unsorted.
      setSortDir((dir) => {
        if (dir === "asc") return "desc";
        // Going from desc → unsorted is handled by setSortKey returning null
        // in the wrapper outside — see below.
        return "asc";
      });
      return current;
    });
  }, []);

  // Re-implement requestSort with full asc → desc → unsorted cycle.
  // (The above closure can't easily clear sortKey from inside the inner setter,
  // so we do it here with a fresh read of state.)
  const requestSortFull = React.useCallback(
    (key: string) => {
      if (sortKey !== key) {
        setSortKey(key);
        setSortDir("asc");
      } else if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        // Third click → drop the sort entirely, reverting to input order.
        setSortKey(null);
        setSortDir("asc");
      }
    },
    [sortKey, sortDir],
  );

  const reset = React.useCallback(() => {
    setSortKey(defaultKey != null ? String(defaultKey) : null);
    setSortDir(defaultDir);
  }, [defaultKey, defaultDir]);

  const sorted = React.useMemo(() => {
    if (!sortKey) return items;
    const key = sortKey;
    const custom = comparators?.[key];
    const accessor = accessors?.[key] ?? ((row: T) => (row as any)[key]);
    // Stable sort by attaching the original index. Array.prototype.sort is
    // stable in modern engines, but the explicit tie-breaker keeps ordering
    // deterministic across browsers and avoids React re-render flicker.
    const indexed = items.map((row, idx) => ({ row, idx }));
    indexed.sort((a, b) => {
      let cmp: number;
      if (custom) {
        cmp = custom(a.row, b.row);
      } else {
        const av = accessor(a.row);
        const bv = accessor(b.row);
        cmp = compareValues(av, bv);
      }
      if (cmp !== 0) return sortDir === "asc" ? cmp : -cmp;
      return a.idx - b.idx;
    });
    return indexed.map((x) => x.row);
  }, [items, sortKey, sortDir, comparators, accessors]);

  return {
    sorted,
    sortKey,
    sortDir,
    requestSort: requestSortFull,
    reset,
  };
}

/**
 * Default comparator. Handles numbers, Dates, strings (locale-aware,
 * case-insensitive), null/undefined (sink to the end), and falls back to
 * `String()` coercion for anything else.
 */
function compareValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined || a === "";
  const bNull = b === null || b === undefined || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1;
  }

  // Numeric strings — common for IDs / SKUs that look like numbers.
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && a !== "" && b !== "") {
    return an - bn;
  }

  return String(a).localeCompare(String(b), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}
