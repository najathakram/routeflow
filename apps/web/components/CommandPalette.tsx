"use client";

import * as React from "react";
import { useGuardedRouter } from "@/lib/use-guarded-router";
import { createPortal } from "react-dom";
import {
  Search,
  Users,
  ShoppingCart,
  Package,
  FileText,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { apiClient } from "@/lib/api-client";
import { displayEmail } from "@/lib/formatting";
import { useI18n } from "@/lib/i18n";
import { useReadOnlyGate } from "@/lib/read-only-gate";
import type { NavEntry } from "@/app/(dashboard)/_components/nav-config";
import {
  NAV_ALIASES,
  navLeaves,
  quickActionHref,
  quickActions,
} from "@/app/(dashboard)/_components/nav-index";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommandItem {
  id: string;
  label: string;
  sublabel?: string;
  icon: LucideIcon;
  action: () => void;
  group: string;
  keywords?: string;
  /** SA-733r6: creates something and the workspace is read-only (QuickAction.blocked): the row stays, disabled, with the shared line. */
  blocked?: boolean;
}

// ─── Rows come from the menu (UXG-R8) ─────────────────────────────────────────

/**
 * Jump to = every entry of the menu the layout built (so a page the menu hides is never offered, and a page it
 * shows always is); Actions = the creating actions that menu can reach. Nothing here is listed by hand: see nav-index.
 */
function useStaticCommands(
  nav: readonly NavEntry[],
  router: ReturnType<typeof useGuardedRouter>,
  staff: boolean,
  readOnly: boolean,
): { navRows: CommandItem[]; actionRows: CommandItem[] } {
  return React.useMemo(() => {
    const navRows = navLeaves(nav).map((leaf): CommandItem => ({
      id: `nav-${leaf.href}`,
      group: "Navigate",
      label: leaf.label,
      icon: leaf.icon,
      action: () => router.push(leaf.href),
      keywords: (NAV_ALIASES[leaf.href] ?? []).join(" ") || undefined,
    }));
    const actionRows = quickActions(nav, { staff, readOnly }).map((a): CommandItem => ({
      id: a.id,
      group: "Actions",
      label: a.label,
      icon: a.icon,
      action: () => router.push(quickActionHref(a)),
      keywords: a.keywords,
      blocked: a.blocked,
    }));
    return { navRows, actionRows };
  }, [nav, router, staff, readOnly]);
}

// ─── Fuzzy filter ──────────────────────────────────────────────────────────────

function fuzzyMatch(item: CommandItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [item.label, item.sublabel, item.keywords, item.group]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  // Simple substring match — good enough for a command palette
  return q.split(" ").every((word) => haystack.includes(word));
}

// ─── Search result types ──────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  label: string;
  sublabel: string;
  href: string;
  icon: LucideIcon;
  group: string;
}

// ─── Search hook ──────────────────────────────────────────────────────────────

function useSearchResults(
  query: string,
  enabled: boolean,
): { results: SearchResult[]; loading: boolean } {
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (!enabled || !query || query.length < 2) {
      setResults([]);
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const [customersRes, ordersRes, invoicesRes, productsRes] = await Promise.allSettled([
          apiClient.get("/customers", { params: { search: query, limit: 4 } }),
          apiClient.get("/orders", { params: { search: query, limit: 4 } }),
          apiClient.get("/invoices", { params: { search: query, limit: 4 } }),
          apiClient.get("/products", { params: { search: query, limit: 4 } }),
        ]);

        const items: SearchResult[] = [];

        if (customersRes.status === "fulfilled") {
          for (const c of customersRes.value.data?.data ?? []) {
            items.push({
              id: `customer-${c.id}`,
              label: c.businessName ?? c.contactName ?? "Unknown",
              sublabel: displayEmail(c.email) ?? c.phone ?? "",
              href: `/customers/${c.id}`,
              icon: Users,
              group: "results",
            });
          }
        }

        if (ordersRes.status === "fulfilled") {
          for (const o of ordersRes.value.data?.data ?? []) {
            items.push({
              id: `order-${o.id}`,
              label: o.orderNumber ?? o.id.slice(0, 8).toUpperCase(),
              sublabel: o.customer?.businessName ?? "",
              href: `/orders/${o.id}`,
              icon: ShoppingCart,
              group: "results",
            });
          }
        }

        if (invoicesRes.status === "fulfilled") {
          for (const inv of invoicesRes.value.data?.data ?? []) {
            items.push({
              id: `invoice-${inv.id}`,
              label: `Invoice #${inv.invoiceNumber}`,
              sublabel: inv.customer?.businessName ?? "",
              href: `/invoices/${inv.id}`,
              icon: FileText,
              group: "results",
            });
          }
        }

        if (productsRes.status === "fulfilled") {
          for (const p of productsRes.value.data?.data ?? []) {
            items.push({
              id: `product-${p.id}`,
              label: p.name ?? "Unnamed product",
              sublabel: p.sku ?? "",
              href: `/products/${p.id}`,
              icon: Package,
              group: "results",
            });
          }
        }

        setResults(items);
      } finally {
        setLoading(false);
      }
    }, 280);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, enabled]);

  return { results, loading };
}

// ─── CommandPalette component ─────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  /** The menu this person has, as the layout built it (buildOperatorNav). */
  nav: readonly NavEntry[];
}

/** Map an internal group key to its localized section label. */
function useGroupLabel() {
  const { t } = useI18n();
  return React.useCallback(
    (group: string) => {
      if (group === "Navigate") return t("palette.jumpTo");
      if (group === "Actions") return t("palette.actions");
      if (group === "results") return t("palette.results");
      return group;
    },
    [t],
  );
}

export function CommandPalette({ open, onClose, nav }: Props) {
  const router = useGuardedRouter(); // POS-7: a selection cannot leave the counter mid-sale
  const readOnlyGate = useReadOnlyGate();
  const { user } = useAuth();
  const { t } = useI18n();
  const groupLabel = useGroupLabel();
  const isOperator =
    !user?.role ||
    user.role === "OPERATOR" ||
    user.role === "SUPER_ADMIN" ||
    user.role === "TENANT_ADMIN";

  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const { navRows, actionRows } = useStaticCommands(nav, router, isOperator, readOnlyGate.readOnly);
  // Empty query: creating comes first (the most frequent job). Typing keeps Jump to first.
  const staticItems = React.useMemo(
    () => (query ? [...navRows, ...actionRows] : [...actionRows, ...navRows]),
    [navRows, actionRows, query],
  );

  const { results: searchResults, loading: searchLoading } = useSearchResults(
    query,
    isOperator && open,
  );

  // Flatten all items into a navigable list
  const flatItems = React.useMemo<
    Array<{ type: "static"; item: CommandItem } | { type: "search"; item: SearchResult }>
  >(() => {
    const filtered = staticItems.filter((i) => fuzzyMatch(i, query));
    const statics = filtered.map((item) => ({ type: "static" as const, item }));
    const searches = searchResults.map((item) => ({ type: "search" as const, item }));
    return [...statics, ...searches];
  }, [staticItems, searchResults, query]);

  // Reset active index when items change
  React.useEffect(() => {
    setActiveIndex(0);
  }, [flatItems.length, query]);

  // Focus input when opened
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = flatItems[activeIndex];
        if (!selected) return;
        if (selected.type === "static" && selected.item.blocked) {
          return; // disabled while read-only: the row says why
        }
        if (selected.type === "static") {
          selected.item.action();
        } else {
          router.push(selected.item.href);
        }
        onClose();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [flatItems, activeIndex, router, onClose],
  );

  // Group items for rendering
  const grouped = React.useMemo(() => {
    const groups: Record<
      string,
      Array<{ flatIndex: number; item: CommandItem | SearchResult; type: "static" | "search" }>
    > = {};
    flatItems.forEach((entry, flatIndex) => {
      const group = entry.type === "static" ? entry.item.group : entry.item.group;
      if (!groups[group]) groups[group] = [];
      groups[group].push({ flatIndex, item: entry.item, type: entry.type });
    });
    return groups;
  }, [flatItems]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh] px-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-surface-border bg-white shadow-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-surface-border px-4 py-3.5">
          <Search className="h-4 w-4 shrink-0 text-navy/70" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t("palette.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/70 focus:outline-none"
          />
          {searchLoading && (
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
          )}
          <kbd className="shrink-0 rounded border border-surface-border bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-navy/70">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {flatItems.length === 0 && !searchLoading ? (
            <p className="px-4 py-8 text-center text-sm text-navy/70">
              {t("palette.noResults", { query })}
            </p>
          ) : (
            Object.entries(grouped).map(([group, entries]) => (
              <div key={group} className="mb-1">
                <p className="px-4 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.09em] text-ink-400">
                  {groupLabel(group)}
                </p>
                {entries.map(({ flatIndex, item, type }) => {
                  const Icon = item.icon;
                  const isActive = flatIndex === activeIndex;
                  const blocked = type === "static" && !!(item as CommandItem).blocked;
                  const sublabel = blocked
                    ? (readOnlyGate.line ?? undefined)
                    : "sublabel" in item
                      ? item.sublabel
                      : undefined;

                  return (
                    <button
                      key={item.id}
                      aria-disabled={blocked || undefined}
                      onClick={() => {
                        if (blocked) return;
                        if (type === "static") {
                          (item as CommandItem).action();
                        } else {
                          router.push((item as SearchResult).href);
                        }
                        onClose();
                      }}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
                        blocked && "cursor-not-allowed opacity-60",
                        isActive
                          ? "bg-[var(--primary-mist)] text-navy shadow-[inset_2.5px_0_0_var(--accent-strong)]"
                          : "text-navy/70 hover:bg-surface-raised",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl",
                          isActive
                            ? "bg-accent-soft text-accent-deep"
                            : "bg-surface-raised text-navy/70",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-navy">{item.label}</p>
                        {sublabel && <p className="truncate text-xs text-navy/70">{sublabel}</p>}
                      </div>
                      {isActive && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-brand-400" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-surface-border px-4 py-2">
          <span className="flex items-center gap-1 text-[11px] text-navy/30">
            <kbd className="rounded border border-surface-border bg-surface-raised px-1 text-[10px]">
              ↑↓
            </kbd>
            {t("palette.navigate")}
          </span>
          <span className="flex items-center gap-1 text-[11px] text-navy/30">
            <kbd className="rounded border border-surface-border bg-surface-raised px-1 text-[10px]">
              ↵
            </kbd>
            {t("palette.select")}
          </span>
          <span className="ml-auto flex items-center gap-1 text-[11px] text-navy/30">
            <kbd className="rounded border border-surface-border bg-surface-raised px-1 text-[10px]">
              ?
            </kbd>
            {t("palette.shortcuts")}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Hook: open palette on Cmd+K / Ctrl+K ─────────────────────────────────────

export function useCommandPalette() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return { open, setOpen };
}
