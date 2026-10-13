"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, UserCircle } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { ReadinessBanner } from "./ReadinessBanner";
import { RouteDefaultsCard } from "./RouteDefaultsCard";
import { BuyerOversellCard } from "./BuyerOversellCard";
import { BusinessCard } from "./BusinessCard";
import { NeedsAttention } from "./NeedsAttention";
import { SettingsFinder } from "./SettingsFinder";
import { normalize, searchSettings } from "./settings-index";
import { hashId } from "./use-hash-scroll";
import { useDesktopRail } from "./use-desktop-rail";
import { useSettingsNav } from "./use-settings-nav";

/**
 * Settings hub: the bare /settings screen. Below xl it is the whole settings list (search, your business,
 * what needs attention, frequent links, the groups with their values). At xl and up the rail (SettingsShell) holds all of that and
 * this shows the big Business card, what needs attention, and the loose cards. Every setting screen stays
 * reachable; role-gated rows are hidden the same way the sidebar hides them.
 */
export function SettingsHub({ isAdmin }: { isAdmin: boolean }) {
  const [query, setQuery] = React.useState("");
  const desktop = useDesktopRail();
  const nav = useSettingsNav({ isAdmin });

  // A row that points at a card on this page ("#out-of-stock-ordering", "#route-defaults") is a plain hash
  // link, but the cards are client-rendered: a page LOADED with the hash has nothing to scroll to until now,
  // so bring the card into view once it is mounted.
  React.useEffect(() => {
    const id = hashId(window.location.hash);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, []);

  // The loose cards follow the search: a card shows when a result points at its anchor (the rail never filters the pane).
  const searching = !desktop && normalize(query) !== "";
  const results = React.useMemo(
    () => (searching ? searchSettings(query, nav.entries) : []),
    [searching, query, nav.entries],
  );
  const listed = (anchor: string) => results.some((r) => r.href?.endsWith(`#${anchor}`));

  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--ink-500)]">
        Manage your business, selling rules, orders, notifications and integrations.
      </p>

      <ReadinessBanner isAdmin={isAdmin} />

      {desktop ? (
        <>
          <BusinessCard variant="pane" />
          <NeedsAttention isAdmin={isAdmin} />
        </>
      ) : (
        <SettingsFinder
          variant="list"
          nav={nav}
          query={query}
          onQuery={setQuery}
          afterCard={<NeedsAttention isAdmin={isAdmin} />}
        />
      )}

      {nav.fleet && (!searching || listed("route-defaults")) && (
        <div id="route-defaults" className="max-w-3xl scroll-mt-28">
          <RouteDefaultsCard />
        </div>
      )}

      {(!searching || listed("out-of-stock-ordering")) && (
        <div id="out-of-stock-ordering" className="max-w-3xl scroll-mt-28">
          <BuyerOversellCard canEdit={isAdmin} />
        </div>
      )}

      {/* My account footer (the rail has its own row) */}
      {!desktop && !searching && (
        <Link
          href="/settings?tab=account"
          className={cn(
            "group flex min-h-[52px] items-center gap-4 rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--paper)] p-4 shadow-[var(--sh-card)] transition-colors [transition-duration:120ms] motion-reduce:transition-none hover:bg-[var(--sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
          )}
        >
          <div className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] bg-[var(--accent-soft)] text-[var(--accent)]">
            <UserCircle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium text-[var(--ink-900)]">My account</div>
            <div className="truncate text-[13px] text-[var(--ink-500)]">
              Password, active sessions, Google sign-in & driver access
            </div>
          </div>
          <span className="flex items-center gap-1 text-sm font-medium text-[var(--accent-strong)]">
            Manage
            <ChevronRight className="h-4 w-4" />
          </span>
        </Link>
      )}
    </div>
  );
}
