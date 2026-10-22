"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

type FilterValue = string | boolean | undefined;
type FilterState = Record<string, FilterValue>;

/**
 * How long a write we made is trusted as "the URL" before it has shown up in `useSearchParams()`. `router.replace` commits
 * asynchronously (a second or two at worst on a slow device), so a write made in that window must build on the previous
 * write, not on the render's stale snapshot (row 729: two filter writes < ~150 ms apart lost the first).
 */
const PENDING_WRITE_MS = 1500;

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
): [
  T,
  (key: keyof T, value: FilterValue) => void,
  () => void,
  (next: Partial<Record<keyof T, FilterValue>>) => void,
] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Every write starts from the latest URL we know of: the one in `searchParams` as of the LATEST render (a handler can
  // hold an older `setFilter`), or the last write still on its way there. Row 729.
  const latestParams = React.useRef(searchParams);
  latestParams.current = searchParams;
  const pendingWrite = React.useRef<{ query: string; at: number } | null>(null);
  // A browser Back/Forward moves the URL out from under any write still on its way: drop it, so the next write builds on
  // the URL the person went back to (Next hands us that as searchParams), not on the write they just left.
  React.useEffect(() => {
    const onPop = () => {
      pendingWrite.current = null;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const baseParams = React.useCallback(() => {
    const current = latestParams.current.toString();
    const pending = pendingWrite.current;
    if (pending && pending.query !== current && Date.now() - pending.at < PENDING_WRITE_MS) {
      return new URLSearchParams(pending.query);
    }
    return new URLSearchParams(current);
  }, []);
  const write = React.useCallback(
    (params: URLSearchParams) => {
      // Always reset to page 1 when filter changes
      params.delete("page");
      const query = params.toString();
      pendingWrite.current = { query, at: Date.now() };
      router.replace(`${pathname}?${query}`, { scroll: false });
    },
    [router, pathname],
  );

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
      const params = baseParams();
      // Remove keys that are empty / false / undefined
      if (value === undefined || value === "" || value === false) {
        params.delete(key as string);
      } else if (typeof value === "boolean") {
        params.set(key as string, "1");
      } else {
        params.set(key as string, value);
      }
      write(params);
    },
    [baseParams, write],
  );

  /**
   * Set several filters in ONE write.
   *
   * One write is still the cleanest way to change several filters at once. (Successive
   * `setFilter` calls now do compose, since each starts from the latest write, but they
   * would still replace the URL once per call.)
   */
  const setFilters = React.useCallback(
    (next: Partial<Record<keyof T, FilterValue>>) => {
      const params = baseParams();
      for (const key in next) {
        const value = next[key];
        if (value === undefined || value === "" || value === false) {
          params.delete(key as string);
        } else if (typeof value === "boolean") {
          params.set(key as string, "1");
        } else {
          params.set(key as string, value as string);
        }
      }
      write(params);
    },
    [baseParams, write],
  );

  const clearAll = React.useCallback(() => {
    // Remove all known filter keys, keep unrelated params (e.g. action)
    const params = baseParams();
    for (const key in defaults) {
      params.delete(key as string);
    }
    write(params);
  }, [baseParams, write, defaults]);

  return [state, setFilter, clearAll, setFilters];
}
