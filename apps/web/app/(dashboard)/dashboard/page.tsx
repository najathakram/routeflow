"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ShoppingCart,
  MapPin,
  Truck,
  AlertTriangle,
  Clock,
  CheckCircle2,
  ArrowRight,
  Package,
  DollarSign,
  FileMinus,
  Plus,
  ExternalLink,
  Briefcase,
  type LucideIcon,
} from "lucide-react";
import { StatCard, Badge, Table, Button, Card, cn, EmptyState } from "@routeflow/ui/web";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { useOrders, type Order } from "@/lib/api/orders";
import { useRouteRuns, type RouteRun } from "@/lib/api/routes";
import { useDrivers, type Driver } from "@/lib/api/drivers";
import { useProducts } from "@/lib/api/products";
import { unitsLabel } from "@/lib/stock-label";
import { useFinanceDashboard } from "@/lib/api/finance";
import { useInvoices, type Invoice } from "@/lib/api/invoices";
import { useDeveloperMode } from "@/lib/api/addons";

// ─── Column definitions (stable refs, defined outside component) ───────────────

const routeColumns: ColumnDef<RouteRun, unknown>[] = [
  {
    accessorKey: "route.name",
    header: "Route",
    cell: ({ row }) => (
      <span className="font-medium text-navy">{row.original.route?.name ?? "—"}</span>
    ),
  },
  {
    id: "driver",
    header: "Driver",
    cell: ({ row }) => (
      <span className="text-navy/70">{row.original.driver?.contactName ?? "Unassigned"}</span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <Badge status={row.original.status} />,
  },
  {
    id: "stops",
    header: "Stops",
    enableSorting: false,
    cell: ({ row }) => {
      const stops = row.original.stops ?? [];
      const done = stops.filter((s) => s.status === "COMPLETED").length;
      const total = row.original._count?.stops ?? stops.length;
      return (
        <span className="mono text-sm text-navy/70">
          {done}/{total}
        </span>
      );
    },
  },
  {
    id: "startTime",
    header: "Start",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-navy/70">
        {row.original.startedAt
          ? new Date(row.original.startedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : row.original.scheduledDate
            ? new Date(row.original.scheduledDate).toLocaleDateString()
            : "—"}
      </span>
    ),
  },
];

const orderColumns: ColumnDef<Order, unknown>[] = [
  {
    accessorKey: "orderNumber",
    header: "Order #",
    cell: ({ row }) => (
      <span className="font-mono text-xs font-semibold text-navy">
        {row.original.orderNumber ?? row.original.id.slice(0, 8).toUpperCase()}
      </span>
    ),
  },
  {
    id: "customer",
    header: "Customer",
    cell: ({ row }) => (
      <span className="text-navy">{row.original.customer?.businessName ?? "—"}</span>
    ),
  },
  {
    id: "items",
    header: "Items",
    cell: ({ row }) => (
      <span className="text-navy/70">{row.original.lineItems?.length ?? 0} item(s)</span>
    ),
  },
  {
    accessorKey: "total",
    header: "Total",
    cell: ({ row }) => (
      <span className="money text-navy">
        ${Number(row.original.total ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    enableSorting: false,
    cell: ({ row }) => <Badge status={row.original.status} />,
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-navy/70">{new Date(row.original.createdAt).toLocaleDateString()}</span>
    ),
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

function daysOverdue(dueDateStr?: string): number {
  if (!dueDateStr) return 0;
  const diff = Date.now() - new Date(dueDateStr).getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtMoney(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function StatSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-surface-border bg-white p-5">
      <div className="mb-3 h-4 w-24 rounded bg-navy/10" />
      <div className="h-8 w-16 rounded bg-navy/10" />
    </div>
  );
}

function ErrorBanner({ message = "Failed to load data" }: { message?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
      <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
      <p className="text-sm text-danger">{message}</p>
    </div>
  );
}

// ─── AR Aging Widget ──────────────────────────────────────────────────────────

interface AgingData {
  total: number;
  current: number;
  days1_15: number;
  days16_30: number;
  days31_45: number;
  days45plus: number;
}

function ArAgingWidget({ aging }: { aging: AgingData }) {
  const num = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const totalValue = num(aging.total);
  const total = totalValue || 1;
  const buckets = [
    { label: "Current", value: num(aging.current), color: "bg-success", textColor: "text-success" },
    { label: "1–15d", value: num(aging.days1_15), color: "bg-warning", textColor: "text-warning" },
    {
      label: "16–30d",
      value: num(aging.days16_30),
      color: "bg-orange-400",
      textColor: "text-orange-500",
    },
    { label: "31–45d", value: num(aging.days31_45), color: "bg-danger", textColor: "text-danger" },
    {
      label: "45d+",
      value: num(aging.days45plus),
      color: "bg-danger/80",
      textColor: "text-danger",
    },
  ].filter((b) => b.value > 0);

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
        <h3 className="text-base font-semibold text-navy">AR Aging</h3>
        <Link
          href="/finance/reports/ar-aging"
          className="flex items-center gap-1 text-xs font-medium text-brand-500 hover:underline"
        >
          Full report <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="p-5 space-y-4">
        {/* Total */}
        <div className="flex items-baseline gap-2">
          <span className="money text-2xl text-navy">
            $
            {totalValue.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span className="text-xs text-navy/70">total outstanding</span>
        </div>

        {/* Stacked bar */}
        <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-sunken">
          {buckets.map((b) => (
            <div
              key={b.label}
              className={cn("h-full transition-all", b.color)}
              style={{ width: `${(b.value / total) * 100}%` }}
            />
          ))}
        </div>

        {/* Legend */}
        <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">
          {buckets.map((b) => (
            <div key={b.label} className="flex flex-col gap-0.5">
              <span className={cn("h-2.5 w-2.5 rounded-[3px]", b.color)} />
              <p className="text-[11.5px] text-navy/70 truncate">{b.label}</p>
              <p className="money text-xs text-navy">{fmtMoney(b.value)}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Overdue Invoices Panel ───────────────────────────────────────────────────

function OverdueInvoicesPanel({
  invoices,
  isLoading,
}: {
  invoices: Invoice[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
        <div className="border-b border-surface-border px-5 py-3.5">
          <div className="h-4 w-32 animate-pulse rounded bg-navy/10" />
        </div>
        <div className="space-y-3 p-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-navy/10" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-navy">Overdue Invoices</h3>
          {invoices.length > 0 && <Badge variant="danger" label={`${invoices.length}`} />}
        </div>
        <Link
          href="/invoices?status=OVERDUE"
          className="flex items-center gap-1 text-xs font-medium text-brand-500 hover:underline"
        >
          View all <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {invoices.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-5">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
          <div>
            <p className="text-sm font-semibold text-success">No overdue invoices</p>
            <p className="mt-0.5 text-xs text-success/70">All invoices are up to date.</p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-surface-border">
          {invoices.map((inv) => {
            const days = daysOverdue(inv.dueDate);
            const balance = Number(inv.balanceDue ?? inv.total ?? 0);
            return (
              <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-navy">
                    {inv.customer?.businessName ?? "Unknown"}
                  </p>
                  <p className="mono mt-0.5 text-xs text-navy/70">#{inv.invoiceNumber}</p>
                </div>
                <Badge variant="danger" label={`${days}d overdue`} />
                <span className="money text-sm text-navy">
                  $
                  {(Number.isFinite(balance) ? balance : 0).toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                  })}
                </span>
                <Link
                  href={`/invoices/${inv.id}`}
                  className="flex items-center gap-0.5 text-xs font-medium text-brand-500 hover:underline"
                >
                  View <ExternalLink className="h-2.5 w-2.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Low Stock Panel ─────────────────────────────────────────────────────────

interface Product {
  id: string;
  name: string;
  /** PIECES (system-wide stock unit) — label via `unitsLabel`, never next to `unit`. */
  currentStock?: number | null;
  lowStockThreshold?: number | null;
  unit?: string;
  unitsPerBox?: number | null;
}

function LowStockPanel({
  products,
  total,
  isLoading,
}: {
  products: Product[];
  total: number;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
        <div className="border-b border-surface-border px-5 py-3.5">
          <div className="h-4 w-32 animate-pulse rounded bg-navy/10" />
        </div>
        <div className="space-y-3 p-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-navy/10" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-navy">Low Stock</h3>
          {total > 0 && <Badge variant="warning" label={fmt(total)} />}
        </div>
        <Link
          href="/products?lowStock=true"
          className="flex items-center gap-1 text-xs font-medium text-brand-500 hover:underline"
        >
          Inventory <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {products.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-5">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
          <p className="text-sm font-semibold text-success">All stock levels healthy</p>
        </div>
      ) : (
        <ul className="divide-y divide-surface-border">
          {products.map((p) => {
            const stockUnset = p.currentStock == null;
            const qty = p.currentStock ?? 0;
            const threshold = p.lowStockThreshold ?? 5;
            const pct = stockUnset ? 0 : Math.min(100, Math.max(0, (qty / (threshold * 2)) * 100));
            return (
              <li key={p.id} className="px-5 py-3">
                <p className="truncate text-sm font-semibold text-navy">{p.name}</p>
                <div className="mt-1 flex items-center justify-between text-xs text-navy/70">
                  <span
                    className={cn(
                      "font-medium",
                      stockUnset ? "text-navy/70" : qty === 0 ? "text-danger" : "text-warning",
                    )}
                  >
                    {stockUnset ? "Not set" : unitsLabel(qty, p.unitsPerBox, p.unit ?? "units")}
                  </span>
                  {!stockUnset && (
                    <span className="mono text-navy/70">
                      {qty}/{threshold}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 h-[5px] w-full overflow-hidden rounded-full bg-sunken">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      stockUnset ? "bg-navy/20" : qty === 0 ? "bg-danger" : "bg-warning",
                    )}
                    style={{ width: stockUnset ? "100%" : `${pct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Mode switcher (dual-role users) ──────────────────────────────────────────

type ViewMode = "operator" | "driver";

const MODE_STORAGE_KEY = "rf-dashboard-view-mode";

function ModeSwitcher({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const segments: { key: ViewMode; label: string; icon: LucideIcon }[] = [
    { key: "operator", label: "Operator", icon: Briefcase },
    { key: "driver", label: "Driver", icon: Truck },
  ];
  return (
    <div
      role="tablist"
      aria-label="Switch view mode"
      className="inline-flex items-center rounded-full border border-surface-border bg-white p-0.5"
    >
      {segments.map((s) => {
        const Icon = s.icon;
        const active = mode === s.key;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              active ? "bg-navy text-white" : "text-navy/70 hover:text-navy",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const { enabled: devMode } = useDeveloperMode();

  const baseIsOperator =
    !user?.role ||
    user.role === "OPERATOR" ||
    user.role === "SUPER_ADMIN" ||
    user.role === "TENANT_ADMIN";
  const isCustomer = user?.role === "CUSTOMER";
  const baseIsDriver = user?.role === "DRIVER";

  const canActAsDriver = user?.canActAsDriver === true && baseIsOperator && devMode;

  // View mode for dual-role users — persisted across visits
  const [viewMode, setViewMode] = React.useState<ViewMode>("operator");
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === "operator" || saved === "driver") {
      setViewMode(saved);
    }
  }, []);
  const updateViewMode = React.useCallback((m: ViewMode) => {
    setViewMode(m);
    if (typeof window !== "undefined") localStorage.setItem(MODE_STORAGE_KEY, m);
  }, []);

  // For dual-role users the mode pill chooses what content shows.
  // Single-role users fall back to their JWT role.
  const isOperator = canActAsDriver ? viewMode === "operator" : baseIsOperator;
  const isDriver = canActAsDriver ? viewMode === "driver" : baseIsDriver;

  React.useEffect(() => {
    setTitle("Dashboard");
  }, [setTitle]);

  // ── Data fetching ──
  const POLL = { refetchInterval: 30_000 };
  const {
    data: allOrdersData,
    isLoading: ordersLoading,
    isError: ordersError,
  } = useOrders({ page: 1, limit: 100 }, POLL);
  const { data: urgentOrdersData, isLoading: urgentLoading } = useOrders(
    { urgent: true, limit: 5 },
    POLL,
  );
  const {
    data: recentOrdersData,
    isLoading: recentLoading,
    isError: recentError,
  } = useOrders({ page: 1, limit: 5 }, POLL);
  const { data: routeRunsData, isLoading: runsLoading } = useRouteRuns(
    { status: "SCHEDULED" },
    POLL,
  );
  const { data: driversData, isLoading: driversLoading } = useDrivers({ page: 1, limit: 20 }, POLL);
  const { data: lowStockData, isLoading: lowStockLoading } = useProducts(
    { isActive: true, stockStatus: "LOW", limit: 5 },
    POLL,
  );
  const { data: financeData, isLoading: financeLoading } = useFinanceDashboard(POLL);
  const { data: overdueData, isLoading: overdueLoading } = useInvoices(
    { status: "OVERDUE", limit: 5, sortBy: "dueDate", sortOrder: "asc" },
    POLL,
  );

  // ── KPI calculations ──
  const activeOrders = React.useMemo(() => {
    const activeStatuses = ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"];
    return (allOrdersData?.data ?? []).filter((o) => activeStatuses.includes(o.status)).length;
  }, [allOrdersData]);

  const orderPipeline = React.useMemo(() => {
    const all = allOrdersData?.data ?? [];
    return {
      PENDING: all.filter((o) => o.status === "PENDING").length,
      CONFIRMED: all.filter((o) => o.status === "CONFIRMED").length,
      OUT_FOR_DELIVERY: all.filter((o) => o.status === "OUT_FOR_DELIVERY").length,
      DELIVERED: all.filter((o) => o.status === "DELIVERED").length,
      CANCELLED: all.filter((o) => o.status === "CANCELLED").length,
    };
  }, [allOrdersData]);

  const routesToday = routeRunsData?.meta?.total ?? 0;
  const driversOnRoad = React.useMemo(
    () => (driversData?.data ?? []).filter((d: Driver) => d.status === "ACTIVE").length,
    [driversData],
  );
  const lowStockTotal = lowStockData?.meta?.total ?? 0;
  const todayRevenue = financeData?.summaryTable?.today?.sales ?? 0;
  const overdueCount = overdueData?.meta?.total ?? 0;
  const overdueInvoices = overdueData?.data ?? [];
  const lowStockProducts: Product[] = lowStockData?.data ?? [];

  const urgentOrders = urgentOrdersData?.data ?? [];
  const activeRoutes = routeRunsData?.data ?? [];
  const recentOrders = recentOrdersData?.data ?? [];
  const drivers = driversData?.data ?? [];

  // ── Greeting data ──
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    enabled: isOperator,
  });

  const greeting = React.useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  }, []);

  const ownerName = settingsData?.ownerName;
  const businessName = settingsData?.businessName;

  return (
    <div className="space-y-6 p-6">
      {/* ── Mode switcher (dual-role users only) ── */}
      {canActAsDriver && (
        <div className="-mb-3 flex justify-end">
          <ModeSwitcher mode={viewMode} onChange={updateViewMode} />
        </div>
      )}

      {/* ── Greeting ── */}
      {isOperator && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div>
            <h2 className="display text-[25px] leading-tight text-navy">
              {greeting}
              {ownerName ? `, ${ownerName}` : ""}.
            </h2>
            {businessName && (
              <p className="mt-0.5 text-sm text-navy/70">
                Here&apos;s what&apos;s happening at {businessName} today.
              </p>
            )}
          </div>
          {/* Quick-create shortcuts */}
          <div className="flex items-center gap-2">
            <Button href="/invoices/new" size="sm" variant="secondary">
              <FileMinus className="mr-1.5 h-3.5 w-3.5" />
              New Invoice
            </Button>
            {devMode && (
              <Button href="/routes/create" size="sm" variant="secondary">
                <Truck className="mr-1.5 h-3.5 w-3.5" />
                New Route
              </Button>
            )}
            <Button href="/orders?action=new" size="sm" variant="primary">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New Order
            </Button>
          </div>
        </div>
      )}

      {/* Customer / driver quick-create */}
      {!isDriver && !isOperator && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-medium text-navy/70">Quick create:</span>
          <Button href="/orders?action=new" size="sm" variant="secondary">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Order
          </Button>
        </div>
      )}

      {/* ── KPI stat cards ── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {isOperator &&
          (financeLoading ? (
            <StatSkeleton />
          ) : (
            <Link href="/finance" className="block">
              <StatCard
                label="Today's Revenue"
                value={`$${Number(todayRevenue).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                icon={<DollarSign className="h-5 w-5 text-success" />}
                className="cursor-pointer transition-shadow hover:shadow-md ring-1 ring-inset ring-success/20"
              />
            </Link>
          ))}
        {(isOperator || isCustomer) &&
          (overdueLoading ? (
            <StatSkeleton />
          ) : (
            <Link href="/invoices?status=OVERDUE" className="block">
              <StatCard
                label="Overdue Invoices"
                value={overdueCount}
                icon={
                  <FileMinus className={cn("h-5 w-5", overdueCount > 0 ? "text-danger" : "")} />
                }
                className={cn(
                  "cursor-pointer transition-shadow hover:shadow-md",
                  overdueCount > 0 ? "ring-1 ring-inset ring-danger/20" : "",
                )}
              />
            </Link>
          ))}
        {ordersLoading ? (
          <StatSkeleton />
        ) : (
          <Link href="/orders" className="block">
            <StatCard
              label="Active Orders"
              value={activeOrders}
              icon={<ShoppingCart className="h-5 w-5" />}
              className="cursor-pointer transition-shadow hover:shadow-md"
            />
          </Link>
        )}
        {(isOperator || isDriver) &&
          devMode &&
          (runsLoading ? (
            <StatSkeleton />
          ) : (
            <Link href="/routes" className="block">
              <StatCard
                label="Scheduled Routes"
                value={routesToday}
                icon={<MapPin className="h-5 w-5" />}
                className="cursor-pointer transition-shadow hover:shadow-md"
              />
            </Link>
          ))}
        {isOperator &&
          devMode &&
          (driversLoading ? (
            <StatSkeleton />
          ) : (
            <Link href="/drivers" className="block">
              <StatCard
                label="Active Drivers"
                value={driversOnRoad}
                icon={<Truck className={cn("h-5 w-5", driversOnRoad > 0 && "text-success")} />}
                className={cn(
                  "cursor-pointer transition-shadow hover:shadow-md",
                  driversOnRoad > 0 ? "ring-1 ring-inset ring-success/20" : "",
                )}
              />
            </Link>
          ))}
        {isOperator &&
          (lowStockLoading ? (
            <StatSkeleton />
          ) : (
            <Link href="/products?lowStock=true" className="block">
              <StatCard
                label="Low Stock Items"
                value={lowStockTotal}
                icon={
                  <AlertTriangle
                    className={cn("h-5 w-5", lowStockTotal > 0 ? "text-warning" : "")}
                  />
                }
                className={cn(
                  "cursor-pointer transition-shadow hover:shadow-md",
                  lowStockTotal > 0 ? "ring-1 ring-inset ring-warning/20" : "",
                )}
              />
            </Link>
          ))}
      </div>

      {/* ── Order pipeline strip (operator only) ── */}
      {isOperator && !ordersLoading && (
        <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
          <div className="grid grid-cols-5 divide-x divide-surface-border">
            {[
              {
                label: "Pending",
                key: "PENDING" as const,
                color: "text-warning",
                bg: "bg-warning-bg",
              },
              {
                label: "Confirmed",
                key: "CONFIRMED" as const,
                color: "text-brand-600",
                bg: "bg-brand-50",
              },
              {
                label: "Out for Delivery",
                key: "OUT_FOR_DELIVERY" as const,
                color: "text-blue-600",
                bg: "bg-blue-50",
              },
              {
                label: "Delivered",
                key: "DELIVERED" as const,
                color: "text-success",
                bg: "bg-success-bg",
              },
              { label: "Cancelled", key: "CANCELLED" as const, color: "text-navy/70", bg: "" },
            ].map(({ label, key, color, bg }) => (
              <Link
                key={key}
                href={`/orders?status=${key}`}
                className={cn(
                  "flex flex-col gap-1 px-[18px] py-[13px] transition-colors hover:bg-surface-raised",
                  bg && orderPipeline[key] > 0 && bg,
                )}
              >
                <span
                  className={cn(
                    "text-xl font-semibold tabular-nums",
                    orderPipeline[key] > 0 ? color : "text-navy/20",
                  )}
                >
                  {orderPipeline[key]}
                </span>
                <span className="text-[11.5px] font-semibold text-navy/70">{label}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Finance insights row (operator only) ── */}
      {isOperator && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* AR Aging */}
          {financeLoading ? (
            <div className="animate-pulse rounded-lg border border-surface-border bg-white p-5">
              <div className="h-4 w-24 rounded bg-navy/10 mb-4" />
              <div className="h-24 rounded bg-navy/10" />
            </div>
          ) : financeData?.arAging ? (
            <ArAgingWidget aging={financeData.arAging} />
          ) : null}

          {/* Overdue invoices action list */}
          <OverdueInvoicesPanel invoices={overdueInvoices} isLoading={overdueLoading} />
        </div>
      )}

      {/* ── Middle row: Urgent Orders + Route Runs + Right column (operator/driver) ── */}
      {(isOperator || isDriver) && (
        <div className={cn("grid grid-cols-1 gap-6", isOperator ? "lg:grid-cols-3" : "")}>
          {/* Left 2/3: Urgent Orders + Route Runs */}
          <div className={cn("flex flex-col gap-6", isOperator ? "lg:col-span-2" : "")}>
            {/* Urgent orders alert panel */}
            {isOperator &&
              (urgentLoading ? (
                <div className="animate-pulse rounded-lg border border-surface-border bg-white p-5">
                  <div className="h-4 w-48 rounded bg-navy/10" />
                </div>
              ) : urgentOrders.length > 0 ? (
                <div className="overflow-hidden rounded-lg border border-danger/40 bg-danger-bg/40 shadow-card">
                  <div className="flex items-center justify-between border-b border-danger/30 px-5 py-3.5">
                    <h3 className="flex items-center gap-2 text-base font-semibold text-[#B91C1C]">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      Urgent Orders
                    </h3>
                    <Badge variant="danger" label={`${urgentOrders.length} open`} />
                  </div>
                  <ul className="divide-y divide-danger/20">
                    {urgentOrders.map((order) => (
                      <li key={order.id} className="flex items-center gap-4 px-5 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-navy">
                            {order.customer?.businessName ?? "Unknown Customer"}
                          </p>
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-navy/70">
                            <Clock className="h-3 w-3" />
                            {order.lineItems?.length ?? 0} items &middot; placed{" "}
                            {timeAgo(order.createdAt)}
                          </p>
                        </div>
                        <Button variant="secondary" size="sm" href={`/orders/${order.id}`}>
                          View Order
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success-bg px-5 py-5 shadow-card">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                  <div>
                    <p className="text-sm font-semibold text-success">All clear</p>
                    <p className="mt-0.5 text-xs text-success/70">No urgent orders at this time.</p>
                  </div>
                </div>
              ))}

            {/* Scheduled route runs */}
            {devMode && (
              <Card>
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-navy">Scheduled Route Runs</h3>
                  <Link
                    href="/routes"
                    className="flex items-center gap-1 text-xs font-medium text-brand-500 hover:underline"
                  >
                    All routes <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
                {runsLoading ? (
                  <div className="animate-pulse space-y-3 py-4">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-10 rounded bg-navy/10" />
                    ))}
                  </div>
                ) : (
                  <div className="-mx-6 -mb-6">
                    <Table
                      data={activeRoutes}
                      columns={routeColumns}
                      onRowClick={(row) => router.push(`/routes/${row.original.id}`)}
                      emptyState={
                        <EmptyState
                          variant="routes"
                          size={56}
                          title="No runs scheduled"
                          description="Dispatch a route to see today's runs here."
                        />
                      }
                    />
                  </div>
                )}
              </Card>
            )}
          </div>

          {/* Right 1/3: Driver Status + Low Stock */}
          {isOperator && (
            <div className="flex flex-col gap-6">
              {devMode && (
                <Card title="Driver Status">
                  {driversLoading ? (
                    <div className="animate-pulse space-y-4 py-2">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="flex items-center gap-3">
                          <div className="h-2 w-2 rounded-full bg-navy/10" />
                          <div className="flex-1 space-y-1">
                            <div className="h-3 w-24 rounded bg-navy/10" />
                            <div className="h-3 w-16 rounded bg-navy/10" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                      {drivers.length === 0 ? (
                        <li className="px-6 py-4 text-sm text-navy/70">No drivers found</li>
                      ) : (
                        drivers.map((driver: Driver) => (
                          <li key={driver.id} className="flex items-start gap-3 px-6 py-4">
                            <span
                              className={cn(
                                "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                                driver.status === "ACTIVE" ? "bg-success" : "bg-navy/20",
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-navy">{driver.contactName}</p>
                              <p className="mt-0.5 text-xs text-navy/70">
                                {driver.vehiclePlate ?? driver.user?.username}
                              </p>
                            </div>
                            <Badge
                              variant={driver.status === "ACTIVE" ? "success" : "neutral"}
                              label={driver.status === "ACTIVE" ? "Active" : "Inactive"}
                            />
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </Card>
              )}

              {/* Low stock items */}
              <LowStockPanel
                products={lowStockProducts}
                total={lowStockTotal}
                isLoading={lowStockLoading}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Recent Orders ── */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-navy">Recent Orders</h2>
          <Link
            href="/orders"
            className="flex items-center gap-1 text-sm text-brand-500 hover:underline"
          >
            View all orders
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        {recentLoading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-10 rounded bg-navy/10" />
            ))}
          </div>
        ) : recentError ? (
          <ErrorBanner message="Could not load recent orders." />
        ) : (
          <div className="-mx-6 -mb-6">
            <Table
              data={recentOrders}
              columns={orderColumns}
              emptyState={
                <EmptyState
                  variant="orders"
                  size={56}
                  title="No orders yet"
                  description="New orders will appear here as they come in."
                />
              }
            />
          </div>
        )}
      </Card>
    </div>
  );
}
