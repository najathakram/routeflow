"use client";

import * as React from "react";
import Link from "next/link";
import {
  Building2,
  Users as UsersIcon,
  Wallet,
  Database,
  Sparkles,
  ShieldCheck,
  UserCircle,
  ChevronRight,
  Search as SearchIcon,
} from "lucide-react";
import { Card, Input, cn } from "@routeflow/ui/web";

/**
 * Settings hub — the grouped-card landing for /settings (full-hub redesign). Every
 * setting screen is reachable from here; clicking a link opens that screen (an
 * existing `?tab=` panel or a standalone /settings sub-page) with a back link. Kept
 * data-driven so the hub, search, and "frequently used" chips stay in sync, and so
 * role-gated screens (Regulated = admin-only) are hidden the same way the sidebar
 * hides them.
 */

type HubItem = {
  label: string;
  desc: string;
  href: string;
  /** When set, the item is only shown if the flag is true (preserves gating). */
  show?: "admin";
};

type HubGroup = {
  key: string;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  items: HubItem[];
};

const GROUPS: HubGroup[] = [
  {
    key: "business",
    title: "Business profile",
    blurb: "Your company identity on documents and the portal.",
    icon: Building2,
    items: [
      {
        label: "Business profile",
        desc: "Name, address, logo & default tax rate",
        href: "/settings?tab=profile",
      },
    ],
  },
  {
    key: "team",
    title: "Team",
    blurb: "The people in your workspace and how they're notified.",
    icon: UsersIcon,
    items: [
      {
        label: "User management",
        desc: "Operators & drivers, roles, passwords",
        href: "/settings?tab=users",
      },
      {
        label: "Notifications",
        desc: "Event rules, message templates & quiet hours",
        href: "/settings?tab=notifications",
      },
    ],
  },
  {
    key: "finance",
    title: "Finance",
    blurb: "Invoicing, costing, payouts and your plan.",
    icon: Wallet,
    items: [
      {
        label: "Invoicing",
        desc: "Numbering, terms & default notes",
        href: "/settings?tab=invoicing",
      },
      { label: "Costing", desc: "Costing method & margin floors", href: "/settings?tab=costing" },
      {
        label: "How to pay",
        desc: "Remit-to & payment instructions",
        href: "/settings?tab=remittance",
      },
      { label: "Plan & billing", desc: "Subscription, usage & add-ons", href: "/settings/billing" },
    ],
  },
  {
    key: "data",
    title: "Data & import",
    blurb: "Bring your data in and set up email delivery.",
    icon: Database,
    items: [
      {
        label: "Import data",
        desc: "CSV importers, numbering & finish setup",
        href: "/settings/import",
      },
      {
        label: "Migration",
        desc: "Move from Zoho, QuickBooks, CSV or paper",
        href: "/settings/migration",
      },
      {
        label: "Batch invoice import",
        desc: "Scan a stack of bills/photos into invoices",
        href: "/settings/batch-import",
      },
      {
        label: "Email (SMTP)",
        desc: "Sender identity & delivery settings",
        href: "/settings?tab=email",
      },
    ],
  },
  {
    key: "integrations",
    title: "Integrations",
    blurb: "Connect external tools and services.",
    icon: Sparkles,
    items: [
      {
        label: "Claude AI scanner",
        desc: "API key for invoice/bill scanning",
        href: "/settings?tab=integrations",
      },
      {
        label: "GoHighLevel",
        desc: "Create customers from won leads",
        href: "/settings?tab=gohighlevel",
      },
    ],
  },
  {
    key: "compliance",
    title: "Compliance",
    blurb: "Regulated products, licensing and reporting.",
    icon: ShieldCheck,
    items: [
      {
        label: "Regulated sections",
        desc: "Tracked categories, tax rules & subcategories",
        href: "/settings?tab=regulated",
        show: "admin",
      },
    ],
  },
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

function HubLink({ item }: { item: HubItem }) {
  return (
    <Link
      href={item.href}
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

export function SettingsHub({ isAdmin }: { isAdmin: boolean }) {
  const [query, setQuery] = React.useState("");

  const canShow = React.useCallback(
    (item: HubItem) => (item.show === "admin" ? isAdmin : true),
    [isAdmin],
  );

  const q = query.trim().toLowerCase();
  const groups = React.useMemo(
    () =>
      GROUPS.map((g) => {
        const items = g.items.filter(
          (it) =>
            canShow(it) &&
            (!q ||
              it.label.toLowerCase().includes(q) ||
              it.desc.toLowerCase().includes(q) ||
              g.title.toLowerCase().includes(q)),
        );
        return { ...g, items };
      }).filter((g) => g.items.length > 0),
    [q, canShow],
  );

  return (
    <div className="space-y-5">
      {/* Header + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-navy/60">
          Manage your workspace, team, finances, data and integrations.
        </p>
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/40" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            className="pl-9"
            aria-label="Search settings"
          />
        </div>
      </div>

      {/* Frequently used */}
      {!q && (
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

      {/* Groups */}
      {groups.length === 0 ? (
        <Card className="text-sm text-navy/60">No settings match “{query}”.</Card>
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
                  href={g.items[0].href}
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
                      <HubLink key={it.href + it.label} item={it} />
                    ))}
                  </div>
                </div>
              );
            return (
              <div key={g.key} className="mb-4 break-inside-avoid">
                {content}
              </div>
            );
          })}
        </div>
      )}

      {/* My account footer */}
      {(!q || "my account password sessions sign-in".includes(q)) && (
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
