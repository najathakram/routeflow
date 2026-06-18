"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

type FilterValue = string | boolean | undefined;
type FilterState = Record<string, FilterValue>;

/**
 * Syncs a set of named filter values to URL search params.
 * Boolean true becomes "1", false/undefined removes the param.
 *
 * Usage:
 *   const [filters, setFilter] = useUrlFilters({ status: "", urgent: false });
 *   setFilter("status", "PENDING");   // ?status=PENDING
 *   setFilter("urgent", true);        // ?urgent=1
 */
export function useUrlFilters<T extends FilterState>(
  defaults: T,
): [T, (key: keyof T, value: FilterValue) => void, () => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read current state from URL, falling back to defaults
  const state = React.useMemo<T>(() => {
    const result = { ...defaults } as T;
    for (const key in defaults) {
      const raw = searchParams.get(key as string);
      if (raw === null) continue;
      const defaultVal = defaults[key];
      if (typeof defaultVal === "boolean") {
        (result as FilterState)[key] = raw === "1";
      } else {
        (result as FilterState)[key] = raw;
      }
    }
    return result;
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = React.useCallback(
    (key: keyof T, value: FilterValue) => {
      const params = new URLSearchParams(searchParams.toString());
      // Remove keys that are empty / false / undefined
      if (value === undefined || value === "" || value === false) {
        params.delete(key as string);
      } else if (typeof value === "boolean") {
        params.set(key as string, "1");
      } else {
        params.set(key as string, value);
      }
      // Always reset to page 1 when filter changes
      params.delete("page");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const clearAll = React.useCallback(() => {
    // Remove all known filter keys, keep unrelated params (e.g. action)
    const params = new URLSearchParams(searchParams.toString());
    for (const key in defaults) {
      params.delete(key as string);
    }
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname, searchParams, defaults]);

  return [state, setFilter, clearAll];
}
