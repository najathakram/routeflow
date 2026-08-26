"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useDebounce } from "./useDebounce";

/**
 * Free-text list search that survives drilling into a row and pressing Back.
 *
 * Drop-in for the `useState` + `useDebounce(search)` pair the list pages used to
 * declare, so a page keeps feeding the debounced value to its query exactly as
 * before:
 *
 *   const [search, setSearch, debouncedSearch] = useUrlSearch();
 *
 * The input value stays in local state so typing is instant, and only the
 * debounced value is mirrored into the URL. That mirror is what Back restores:
 * leaving for a detail page pushes a new entry, so Back returns to the list
 * entry with `?search=` still on it and the box re-hydrates from the URL.
 *
 * Uses a shallow `history.replaceState`, never `push` — replacing overwrites
 * the current history entry, so a 20-character query leaves ONE entry and Back
 * exits the list instead of replaying the search one character at a time. And
 * it must be `replaceState`, not `router.replace`: the debounced write can land
 * while a `router.push` to a detail page is in flight, and a router.replace
 * there cancels the push (the clicked row silently never opens).
 *
 * Only for list searches that own the page's URL. Searches scoped to a modal or
 * an inline picker must stay local: they have no history entry to return from,
 * and publishing them would make an unrelated Escape/close re-hydrate the box.
 */
export function useUrlSearch(
  key = "search",
  delay = 300,
): [string, (next: string) => void, string] {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlValue = searchParams.get(key) ?? "";
  const [value, setValue] = React.useState(urlValue);
  const debounced = useDebounce(value, delay);

  // The last value this hook put in (or took from) the URL. It lets a URL change
  // we caused be told apart from one the user caused with Back/Forward.
  const settled = React.useRef(urlValue);

  // URL -> input, for history navigation only. Without the guard our own write
  // would echo back and overwrite keystrokes typed during the debounce window.
  React.useEffect(() => {
    if (urlValue === settled.current) return;
    settled.current = urlValue;
    setValue(urlValue);
  }, [urlValue]);

  // Input -> URL, once the typing settles. Nothing is written on mount, because
  // useDebounce seeds from the initial value and it already equals `settled`.
  React.useEffect(() => {
    if (debounced === settled.current) return;
    settled.current = debounced;
    // Read the live query string rather than the `searchParams` this effect
    // closed over: the write lands a beat after the keystroke, and a filter chip
    // toggled in between is only in the live URL. Rebuilding from the captured
    // snapshot would resurrect params that chip removed, and drop the ones it
    // added — the stale-snapshot trap documented on customers/page.tsx's
    // clearAll, which a debounced writer hits far more often than a chip does.
    const params = new URLSearchParams(window.location.search);
    if (debounced) params.set(key, debounced);
    else params.delete(key);
    // A changed query re-ranks everything, so any page cursor is meaningless.
    params.delete("page");
    const qs = params.toString();
    // Shallow replaceState, NOT router.replace: this write lands up to `delay`
    // ms after the last keystroke, and a router.replace fired in that window
    // CANCELS an in-flight router.push — type, click a row within the debounce
    // window, and the click was silently swallowed (the row never opened;
    // reproduced via e2e 17's create→search→open flow, where a fast local API
    // made the filtered row clickable before the write landed). replaceState
    // only mutates the current history entry's URL — nothing for the router to
    // cancel — and Next ≥14.1 syncs usePathname/useSearchParams from it, so
    // Back-restore (e2e 12) still sees `?search=` on the list entry.
    window.history.replaceState(window.history.state, "", qs ? `${pathname}?${qs}` : pathname);
  }, [debounced, key, pathname]);

  return [value, setValue, debounced];
}
