"use client";

import * as React from "react";
import Link from "next/link";
import {
  Building2,
  ShoppingBag,
  Truck,
  Bell,
  Wallet,
  Sparkles,
  ShieldCheck,
  UserCircle,
  ChevronRight,
  Search as SearchIcon,
} from "lucide-react";
import { Button, Card, Input, cn } from "@routeflow/ui/web";
import { ReadinessBanner } from "./ReadinessBanner";
import { RouteDefaultsCard } from "./RouteDefaultsCard";
import {
  GROUP_TITLES,
  ROUTE_DEFAULTS_ID,
  breadcrumb,
  buildIndex,
  normalize,
  searchIndex,
  type IndexEntry,
} from "./settings-index";

/**
 * Settings hub — the grouped-card landing for /settings (full-hub redesign). Every
 * setting screen is reachable from here; clicking a link opens that screen (an
 * existing `?tab=` panel or a standalone /settings sub-page) with a back link. The
 * links and the search read ONE data file (`settings-index.ts`), so they cannot drift,
 * and role-gated screens (Regulated = admin-only) are hidden the same way the sidebar
 * hides them.
 */

type HubGroup = {
  key: string;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  items: IndexEntry[];
};

/** The group cards, in order: the key (which names the index entries), a blurb and an icon. */
const GROUP_META: { key: string; blurb: string; icon: HubGroup["icon"] }[] = [
  {
    key: "business",
    blurb: "Your company identity and the people in your workspace.",
    icon: Building2,
  },
  {
    key: "selling",
    blurb: "Pricing, invoicing, restrictions and bringing your catalog in.",
    icon: ShoppingBag,
  },
  {
    key: "orders",
    blurb: "How orders, routes and bills are handled day to day.",
    icon: Truck,
  },
  { key: "notifications", blurb: "What gets sent, to whom, and from where.", icon: Bell },
  {
    key: "compliance",
    blurb: "Regulated products, licensing and reporting.",
    icon: ShieldCheck,
  },
  { key: "integrations", blurb: "Connect external tools and services.", icon: Sparkles },
  { key: "billing", blurb: "Your subscription, usage and add-ons.", icon: Wallet },
];

const CHIPS: { label: string; href: string }[] = [
  { label: "Invoicing", href: "/settings?tab=invoicing" },
  { label: "User management", href: "/settings?tab=users" },
  { label: "Import", href: "/settings/import" },
  { label: "Notifications", href: "/settings?tab=notifications" },
];

function GroupIcon({ icon: Icon }: { icon: HubGroup["icon"] }) {
  return (
    <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600">
      <Icon className="h-[18px] w-[18px]" />
    </div>
  );
}

function HubLink({ item }: { item: IndexEntry }) {
  return (
    <Link
      href={item.href!}
      className="group -mx-2 flex items-start justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-brand-50/60"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-navy group-hover:text-brand-700">
          {item.label}
        </span>
        <span className="block truncate text-xs text-navy/55">{item.desc}</span>
      </span>
      <ChevronRight className="mt-0.5 h-4 w-4 flex-none text-navy/30 group-hover:text-brand-500" />
    </Link>
  );
}

/** One search result: the label, what it is, and where it lives. An answer row is not a link. */
function SearchRow({ entry }: { entry: IndexEntry }) {
  const body = (
    <span className="min-w-0">
      <span className="block text-sm font-medium text-navy group-hover:text-brand-700">
        {entry.label}
      </span>
      <span className="block text-xs text-navy/55">
        {entry.affects ?? entry.answer ?? entry.desc}
      </span>
      <span className="mt-0.5 block text-[11px] text-navy/40">{breadcrumb(entry)}</span>
    </span>
  );
  if (entry.kind === "info" || !entry.href) {
    return <div className="-mx-2 rounded-md px-2 py-2">{body}</div>;
  }
  return (
    <Link
      href={entry.href}
      className="group -mx-2 flex items-start justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-brand-50/60"
    >
      {body}
      <ChevronRight className="mt-0.5 h-4 w-4 flex-none text-navy/30 group-hover:text-brand-500" />
    </Link>
  );
}

export function SettingsHub({ isAdmin }: { isAdmin: boolean }) {
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  // The tenant-has-a-fleet gate arrives with the fleet-off work; until then every tenant sees Route defaults.
  const entries = React.useMemo(() => buildIndex({ isAdmin, fleet: true }), [isAdmin]);

  // A query with no letters or digits ("&", "?") is no search: the hub shows as it always did.
  const searching = normalize(query) !== "";
  const results = React.useMemo(
    () => (searching ? searchIndex(query, entries) : []),
    [searching, query, entries],
  );

  const groups: HubGroup[] = React.useMemo(
    () =>
      GROUP_META.map((g) => ({
        ...g,
        title: GROUP_TITLES[g.key],
        items: entries.filter((e) => e.kind === "item" && e.groupKey === g.key),
      })).filter((g) => g.items.length > 0),
    [entries],
  );

  return (
    <div className="space-y-5">
      {/* Header + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-navy/60">
          Manage your business, selling rules, orders, notifications and integrations.
        </p>
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/40" />
          <Input
            value={query}
            ref={inputRef}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            className="pl-9"
            aria-label="Search settings"
          />
        </div>
      </div>

      <ReadinessBanner isAdmin={isAdmin} />

      {/* Frequently used */}
      {!searching && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-navy/50">
          <span>Frequently used:</span>
          {CHIPS.map((c) => (
            <Link
              key={c.href + c.label}
              href={c.href}
              className="rounded-full border border-surface-border bg-white px-3 py-1 font-medium text-brand-600 transition-colors hover:border-brand-400 hover:bg-brand-50"
            >
              {c.label}
            </Link>
          ))}
        </div>
      )}

      {/* Groups, or the flat search results */}
      {searching ? (
        results.length === 0 ? (
          <Card className="space-y-2 text-sm text-navy/60">
            <p>No settings match “{query}”.</p>
            <p>Try another word, or browse all settings.</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              Clear Search
            </Button>
          </Card>
        ) : (
          <Card>
            <ul aria-label="Search results" className="flex flex-col">
              {results.map((e) => (
                <li key={e.id}>
                  <SearchRow entry={e} />
                </li>
              ))}
            </ul>
          </Card>
        )
      ) : (
        // Masonry columns so each card is only as tall as its content (no empty
        // stretch to match a taller neighbour) — keeps the grid balanced whatever the
        // per-group link count.
        <div className="gap-4 md:columns-2 xl:columns-3">
          {groups.map((g) => {
            const cardClass =
              "block rounded-lg bg-white p-5 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-dropdown";
            // A single-purpose group is ONE clean clickable card (no redundant repeated
            // link); a multi-item group shows its header + a list of links.
            const content =
              g.items.length === 1 ? (
                <Link
                  href={g.items[0].href!}
                  className={cn(cardClass, "group flex items-start gap-3")}
                >
                  <GroupIcon icon={g.icon} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold text-navy group-hover:text-brand-700">
                      {g.title}
                    </div>
                    <div className="mt-0.5 text-xs text-navy/55">{g.items[0].desc}</div>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 flex-none text-navy/30 group-hover:text-brand-500" />
                </Link>
              ) : (
                <div className={cn(cardClass, "flex flex-col gap-3")}>
                  <div className="flex items-center gap-3">
                    <GroupIcon icon={g.icon} />
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold text-navy">{g.title}</div>
                      <div className="text-xs text-navy/50">{g.blurb}</div>
                    </div>
                  </div>
                  <div className="flex flex-col">
                    {g.items.map((it) => (
                      <HubLink key={it.id} item={it} />
                    ))}
                  </div>
                </div>
              );
            return (
              <div
                key={g.key}
                data-testid={`settings-group-${g.key}`}
                className="mb-4 break-inside-avoid"
              >
                {content}
              </div>
            );
          })}
        </div>
      )}

      {(!searching || results.some((r) => r.id === ROUTE_DEFAULTS_ID)) && (
        <div id="route-defaults" className="max-w-3xl">
          <RouteDefaultsCard />
        </div>
      )}

      {/* My account footer */}
      {/* While searching, My account is one of the results. */}
      {!searching && (
        <Link
          href="/settings?tab=account"
          className={cn(
            "group flex items-center gap-4 rounded-lg bg-white p-4 shadow-card transition-shadow hover:shadow-dropdown",
          )}
        >
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <UserCircle className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-navy">My account</div>
            <div className="truncate text-xs text-navy/55">
              Password, active sessions, Google sign-in & driver access
            </div>
          </div>
          <span className="flex items-center gap-1 text-sm font-medium text-brand-600">
            Manage
            <ChevronRight className="h-4 w-4" />
          </span>
        </Link>
      )}
    </div>
  );
}
