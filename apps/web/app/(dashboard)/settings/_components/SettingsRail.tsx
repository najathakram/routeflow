"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { SettingsFinder } from "./SettingsFinder";
import { activeEntryIds } from "./settings-index";
import { useLocationHash } from "./use-hash-scroll";
import { useSettingsNav } from "./use-settings-nav";

/** The persistent left rail (xl and up): search, your business, every group; the open row is aria-current. */
export function SettingsRail({ isAdmin }: { isAdmin: boolean }) {
  const nav = useSettingsNav({ isAdmin });
  const [query, setQuery] = React.useState("");
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const hash = useLocationHash();
  const active = activeEntryIds(nav.entries, { pathname, tab, hash });
  return (
    <nav aria-label="Settings">
      <a
        href="#settings-content"
        className="sr-only focus:not-sr-only focus:mb-2 focus:block focus:rounded-md focus:bg-[var(--paper)] focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--accent-strong)] focus:ring-2 focus:ring-inset focus:ring-primary"
      >
        Skip to settings content
      </a>
      <SettingsFinder variant="rail" nav={nav} query={query} onQuery={setQuery} active={active} />
    </nav>
  );
}
