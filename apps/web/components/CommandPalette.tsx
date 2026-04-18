"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  Search,
  LayoutDashboard,
  ShoppingCart,
  MapPin,
  Truck,
  Users,
  Package,
  Settings,
  FileText,
  Plus,
  ArrowRight,
  RotateCcw,
  FileCheck,
  Wallet,
  BarChart2,
  Receipt,
  CreditCard,
  ShoppingBag,
  BarChart3,
  Building2,
  Layers,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { apiClient } from "@/lib/api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommandItem {
  id: string;
  label: string;
  sublabel?: string;
  icon: LucideIcon;
  action: () => void;
  group: string;
  keywords?: string;
}

// ─── Static command definitions ───────────────────────────────────────────────

function useStaticCommands(router: ReturnType<typeof useRouter>): CommandItem[] {
  return React.useMemo(
    () => [
      // ─ Navigation ──
      { id: "nav-dashboard",    group: "Navigate",  label: "Dashboard",       icon: LayoutDashboard, action: () => router.push("/dashboard"),        keywords: "home" },
      { id: "nav-orders",       group: "Navigate",  label: "All Orders",      icon: ShoppingCart,    action: () => router.push("/orders") },
      { id: "nav-returns",      group: "Navigate",  label: "Returns",         icon: RotateCcw,       action: () => router.push("/returns") },
      { id: "nav-routes",       group: "Navigate",  label: "Routes",          icon: MapPin,          action: () => router.push("/routes") },
      { id: "nav-drivers",      group: "Navigate",  label: "Drivers",         icon: Truck,           action: () => router.push("/drivers") },
      { id: "nav-customers",    group: "Navigate",  label: "Customers",       icon: Users,           action: () => router.push("/customers") },
      { id: "nav-products",     group: "Navigate",  label: "Products",        icon: Package,         action: () => router.push("/products") },
      { id: "nav-inventory",    group: "Navigate",  label: "Inventory",       icon: Layers,          action: () => router.push("/inventory") },
      { id: "nav-suppliers",    group: "Navigate",  label: "Suppliers",       icon: Building2,       action: () => router.push("/suppliers") },
      { id: "nav-invoices",     group: "Navigate",  label: "Invoices",        icon: FileText,        action: () => router.push("/invoices") },
      { id: "nav-estimates",    group: "Navigate",  label: "Estimates",       icon: FileCheck,       action: () => router.push("/estimates") },
      { id: "nav-credit-notes", group: "Navigate",  label: "Credit Notes",    icon: Receipt,         action: () => router.push("/credit-notes") },
      { id: "nav-payments",     group: "Navigate",  label: "Payments",        icon: CreditCard,      action: () => router.push("/finance/payments") },
      { id: "nav-expenses",     group: "Navigate",  label: "Expenses",        icon: ShoppingBag,     action: () => router.push("/finance/expenses") },
      { id: "nav-finance",      group: "Navigate",  label: "Finance Overview",icon: Wallet,          action: () => router.push("/finance/dashboard") },
      { id: "nav-reports",      group: "Navigate",  label: "Reports",         icon: BarChart3,       action: () => router.push("/finance/reports") },
      { id: "nav-analytics",    group: "Navigate",  label: "Analytics",       icon: BarChart2,       action: () => router.push("/analytics") },
      { id: "nav-settings",     group: "Navigate",  label: "Settings",        icon: Settings,        action: () => router.push("/settings") },
      // ─ Actions ──
      { id: "act-new-order",    group: "Actions",   label: "New Order",       icon: Plus,            action: () => router.push("/orders?action=new"),   keywords: "create add order" },
      { id: "act-new-invoice",  group: "Actions",   label: "New Invoice",     icon: Plus,            action: () => router.push("/invoices/new"),         keywords: "create add invoice" },
      { id: "act-new-route",    group: "Actions",   label: "New Route",       icon: Plus,            action: () => router.push("/routes/create"),        keywords: "create add route" },
      { id: "act-new-customer", group: "Actions",   label: "New Customer",    icon: Plus,            action: () => router.push("/customers?action=new"), keywords: "create add customer" },
      { id: "act-new-product",  group: "Actions",   label: "New Product",     icon: Plus,            action: () => router.push("/products?action=new"),  keywords: "create add product" },
    ],
    [router]
  );
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

function useSearchResults(query: string, enabled: boolean): { results: SearchResult[]; loading: boolean } {
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
        const [customersRes, ordersRes, invoicesRes] = await Promise.allSettled([
          apiClient.get("/customers", { params: { search: query, limit: 4 } }),
          apiClient.get("/orders",    { params: { search: query, limit: 4 } }),
          apiClient.get("/invoices",  { params: { search: query, limit: 4 } }),
        ]);

        const items: SearchResult[] = [];

        if (customersRes.status === "fulfilled") {
          for (const c of customersRes.value.data?.data ?? []) {
            items.push({
              id: `customer-${c.id}`,
              label: c.businessName ?? c.contactName ?? "Unknown",
              sublabel: c.email ?? c.phone ?? "",
              href: `/customers/${c.id}`,
              icon: Users,
              group: "Customers",
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
              group: "Orders",
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
              group: "Invoices",
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
}

export function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const isOperator = !user?.role || user.role === "OPERATOR" || user.role === "SUPER_ADMIN" || user.role === "TENANT_ADMIN";

  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const allStatic = useStaticCommands(router);

  // For non-operators, restrict navigation items
  const staticItems = React.useMemo(() => {
    if (isOperator) return allStatic;
    if (user?.role === "CUSTOMER") return allStatic.filter((i) =>
      ["nav-dashboard", "nav-orders", "nav-returns", "nav-invoices", "nav-settings", "act-new-order"].includes(i.id)
    );
    if (user?.role === "DRIVER") return allStatic.filter((i) =>
      ["nav-dashboard", "nav-routes", "nav-settings"].includes(i.id)
    );
    return allStatic;
  }, [allStatic, isOperator, user?.role]);

  const { results: searchResults, loading: searchLoading } = useSearchResults(query, isOperator && open);

  // Flatten all items into a navigable list
  const flatItems = React.useMemo<Array<{ type: "static"; item: CommandItem } | { type: "search"; item: SearchResult }>>(() => {
    const filtered = staticItems.filter((i) => fuzzyMatch(i, query));
    const statics = filtered.map((item) => ({ type: "static" as const, item }));
    const searches = searchResults.map((item) => ({ type: "search" as const, item }));
    return [...searches, ...statics];
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
  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
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
      if (selected.type === "static") {
        selected.item.action();
      } else {
        router.push(selected.item.href);
      }
      onClose();
    } else if (e.key === "Escape") {
      onClose();
    }
  }, [flatItems, activeIndex, router, onClose]);

  // Group items for rendering
  const grouped = React.useMemo(() => {
    const groups: Record<string, Array<{ flatIndex: number; item: CommandItem | SearchResult; type: "static" | "search" }>> = {};
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
          <Search className="h-4 w-4 shrink-0 text-navy/40" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search pages, customers, orders, invoices…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/40 focus:outline-none"
          />
          {searchLoading && (
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
          )}
          <kbd className="shrink-0 rounded border border-surface-border bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-navy/40">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {flatItems.length === 0 && !searchLoading ? (
            <p className="px-4 py-8 text-center text-sm text-navy/40">
              No results for &ldquo;{query}&rdquo;
            </p>
          ) : (
            Object.entries(grouped).map(([group, entries]) => (
              <div key={group} className="mb-1">
                <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-navy/30">
                  {group}
                </p>
                {entries.map(({ flatIndex, item, type }) => {
                  const Icon = item.icon;
                  const isActive = flatIndex === activeIndex;
                  const sublabel = "sublabel" in item ? item.sublabel : undefined;

                  return (
                    <button
                      key={item.id}
                      onClick={() => {
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
                        isActive ? "bg-brand-50 text-navy" : "text-navy/70 hover:bg-surface-raised"
                      )}
                    >
                      <span className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                        isActive ? "bg-brand-100 text-brand-600" : "bg-surface-raised text-navy/40"
                      )}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-navy">{item.label}</p>
                        {sublabel && (
                          <p className="truncate text-xs text-navy/50">{sublabel}</p>
                        )}
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
            <kbd className="rounded border border-surface-border bg-surface-raised px-1 text-[10px]">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1 text-[11px] text-navy/30">
            <kbd className="rounded border border-surface-border bg-surface-raised px-1 text-[10px]">↵</kbd>
            select
          </span>
          <span className="flex items-center gap-1 text-[11px] text-navy/30">
            <kbd className="rounded border border-surface-border bg-surface-raised px-1 text-[10px]">ESC</kbd>
            close
          </span>
        </div>
      </div>
    </div>,
    document.body
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
