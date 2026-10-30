"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { SettingsFinder } from "./SettingsFinder";
import {
  isSettingsHub,
  recallReturnedQuery,
  recallSettingsQuery,
  rememberSettingsQuery,
} from "./settings-query-memory";
import { activeEntryIds } from "./settings-index";
import { useLocationHash } from "./use-hash-scroll";
import { useSettingsNav } from "./use-settings-nav";

/** The persistent left rail (xl and up): search, your business, every group; the open row is aria-current. */
export function SettingsRail({ isAdmin }: { isAdmin: boolean }) {
  const nav = useSettingsNav({ isAdmin });
  const [query, setQueryState] = React.useState("");
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get("tab");
  const hash = useLocationHash();
  const setQuery = React.useCallback((q: string) => {
    setQueryState(q);
    rememberSettingsQuery(q);
  }, []);
  // W-937: the query's memory across Back is the hub's own (settings-query-memory), one owner for both finders. The rail
  // lives in the settings layout, so it outlives every navigation and asks the memory on the hub, as the hub's finder does
  // when it mounts: a Back/Forward that landed here brings the query back, a fresh visit starts empty.
  React.useEffect(() => {
    if (!isSettingsHub(pathname)) return;
    const restored = recallSettingsQuery();
    if (restored) setQueryState(restored);
    // on mount only: the location effect below handles every later change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // SA PR1b M1: any location change (a result click, a link, a fresh visit to /settings) clears the search, so results
  // never stay stuck over a screen and the current row shows. The memory is left alone: Back to the hub reads it above.
  const location = `${pathname}?${params.toString()}${hash}`;
  const lastLocation = React.useRef(location);
  React.useEffect(() => {
    if (lastLocation.current === location) return;
    lastLocation.current = location;
    setQueryState(isSettingsHub(pathname) ? recallReturnedQuery() : "");
    // pathname is part of `location`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);
  const active = activeEntryIds(nav.entries, { pathname, tab, hash });
  return (
    <nav aria-label="Settings">
      <a
        href="#settings-content"
        onClick={(e) => {
          // move focus into the content without a hash jump (the hash scroll would treat it as a deep link)
          e.preventDefault();
          const content = document.getElementById("settings-content");
          content?.focus({ preventScroll: true });
          content?.scrollIntoView?.({ block: "start" });
        }}
        className="sr-only focus:not-sr-only focus:mb-2 focus:block focus:rounded-md focus:bg-[var(--paper)] focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--accent-strong)] focus:ring-2 focus:ring-inset focus:ring-primary"
      >
        Skip to settings content
      </a>
      <SettingsFinder variant="rail" nav={nav} query={query} onQuery={setQuery} active={active} />
    </nav>
  );
}
