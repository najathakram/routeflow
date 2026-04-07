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
  TrendingUp,
  Package,
  DollarSign,
  FileMinus,
  Plus,
} from "lucide-react";
import { StatCard, Badge, Table, Button, Card, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useOrders, type Order } from "@/lib/api/orders";
import { useRouteRuns, type RouteRun } from "@/lib/api/routes";
import { useDrivers, type Driver } from "@/lib/api/drivers";
import { useProducts } from "@/lib/api/products";
import { useFinanceDashboard } from "@/lib/api/finance";
import { useInvoices } from "@/lib/api/invoices";

// ─── Column definitions (stable refs, defined outside component) ───────────────

const routeColumns: ColumnDef<RouteRun, unknown>[] = [
  {
    accessorKey: "route.name",
    header: "Route Name",
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
        <span className="text-sm text-navy/70">
          {done} / {total}
        </span>
      );
    },
  },
  {
    id: "startTime",
    header: "Start Time",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-navy/70">
        {row.original.startedAt
          ? new Date(row.original.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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
      <span className="font-medium text-navy">
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
      <span className="text-navy/60">
        {new Date(row.original.createdAt).toLocaleDateString()}
      </span>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();

  React.useEffect(() => {
    setTitle("Dashboard");
  }, [setTitle]);

  // ── Data fetching ──
  const { data: allOrdersData, isLoading: ordersLoading, isError: ordersError } = useOrders({ page: 1, limit: 100 });
  const { data: urgentOrdersData, isLoading: urgentLoading, isError: urgentError } = useOrders({ urgent: true, limit: 5 });
  const { data: recentOrdersData, isLoading: recentLoading, isError: recentError } = useOrders({ page: 1, limit: 5 });
  const { data: routeRunsData, isLoading: runsLoading, isError: runsError } = useRouteRuns({ status: "SCHEDULED" });
  const { data: driversData, isLoading: driversLoading, isError: driversError } = useDrivers({ page: 1, limit: 20 });
  const { data: lowStockData, isLoading: lowStockLoading, isError: lowStockError } = useProducts({ isActive: true, stockStatus: "LOW", limit: 1 });
  const { data: financeData, isLoading: financeLoading, isError: financeError } = useFinanceDashboard();
  const { data: overdueData, isLoading: overdueLoading, isError: overdueError } = useInvoices({ status: "OVERDUE", limit: 1 });

  // ── KPI calculations ──
  const activeOrders = React.useMemo(() => {
    const activeStatuses = ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"];
    return (allOrdersData?.data ?? []).filter((o) => activeStatuses.includes(o.status)).length;
  }, [allOrdersData]);

  // Order pipeline counts
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
    [driversData]
  );
  const lowStockItems = lowStockData?.meta?.total ?? 0;
  const todayRevenue = financeData?.summaryTable?.today?.sales ?? 0;
  const overdueCount = overdueData?.meta?.total ?? 0;

  const isLoading = ordersLoading || runsLoading || driversLoading || lowStockLoading;

  const urgentOrders = urgentOrdersData?.data ?? [];
  const activeRoutes = routeRunsData?.data ?? [];
  const recentOrders = recentOrdersData?.data ?? [];
  const drivers = driversData?.data ?? [];

  return (
    <div className="space-y-6 p-6">

      {/* ── Quick-create shortcuts ── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm font-medium text-navy/50">Quick create:</span>
        <Button href="/orders?action=new" size="sm" variant="secondary">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Order
        </Button>
        <Button href="/routes?action=new" size="sm" variant="secondary">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Route
        </Button>
        <Button href="/invoices/new" size="sm" variant="secondary">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Invoice
        </Button>
      </div>

      {/* ── KPI stat cards ── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {financeLoading ? <StatSkeleton /> : financeError ? (
          <div className="rounded-lg border border-danger/20 bg-danger/5 p-4 text-center text-xs text-danger">Revenue unavailable</div>
        ) : (
          <Link href="/finance" className="block">
            <StatCard
              label="Today's Revenue"
              value={`$${Number(todayRevenue).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              icon={<DollarSign className="h-5 w-5 text-success" />}
              className="cursor-pointer transition-shadow hover:shadow-md ring-1 ring-inset ring-success/20"
            />
          </Link>
        )}
        {overdueLoading ? <StatSkeleton /> : overdueError ? (
          <div className="rounded-lg border border-danger/20 bg-danger/5 p-4 text-center text-xs text-danger">Could not load invoices</div>
        ) : (
          <Link href="/invoices?status=OVERDUE" className="block">
            <StatCard
              label="Overdue Invoices"
              value={overdueCount}
              icon={
                <FileMinus
                  className={cn("h-5 w-5", overdueCount > 0 ? "text-danger" : "")}
                />
              }
              className={cn(
                "cursor-pointer transition-shadow hover:shadow-md",
                overdueCount > 0 ? "ring-1 ring-inset ring-danger/20" : ""
              )}
            />
          </Link>
        )}
        {ordersLoading ? <StatSkeleton /> : ordersError ? (
          <div className="rounded-lg border border-danger/20 bg-danger/5 p-4 text-center text-xs text-danger">Could not load orders</div>
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
        {runsLoading ? <StatSkeleton /> : runsError ? (
          <div className="rounded-lg border border-danger/20 bg-danger/5 p-4 text-center text-xs text-danger">Could not load routes</div>
        ) : (
          <Link href="/routes" className="block">
            <StatCard
              label="Scheduled Routes"
              value={routesToday}
              icon={<MapPin className="h-5 w-5" />}
              className="cursor-pointer transition-shadow hover:shadow-md"
            />
          </Link>
        )}
        {driversLoading ? <StatSkeleton /> : driversError ? (
          <div className="rounded-lg border border-danger/20 bg-danger/5 p-4 text-center text-xs text-danger">Could not load drivers</div>
        ) : (
          <Link href="/drivers" className="block">
            <StatCard
              label="Active Drivers"
              value={driversOnRoad}
              icon={<Truck className={cn("h-5 w-5", driversOnRoad > 0 && "text-success")} />}
              className={cn(
                "cursor-pointer transition-shadow hover:shadow-md",
                driversOnRoad > 0 ? "ring-1 ring-inset ring-success/20" : ""
              )}
            />
          </Link>
        )}
        {lowStockLoading ? <StatSkeleton /> : lowStockError ? (
          <div className="rounded-lg border border-danger/20 bg-danger/5 p-4 text-center text-xs text-danger">Could not load inventory</div>
        ) : (
          <Link href="/products?lowStock=true" className="block">
            <StatCard
              label="Low Stock Items"
              value={lowStockItems}
              icon={
                <AlertTriangle
                  className={cn("h-5 w-5", lowStockItems > 0 ? "text-warning" : "")}
                />
              }
              className={cn(
                "cursor-pointer transition-shadow hover:shadow-md",
                lowStockItems > 0 ? "ring-1 ring-inset ring-warning/20" : ""
              )}
            />
          </Link>
        )}
      </div>

      {/* ── Order pipeline strip ── */}
      {!ordersLoading && (
        <div className="overflow-hidden rounded-lg border border-surface-border bg-white">
          <div className="flex items-center gap-2 border-b border-surface-border px-4 py-2.5">
            <TrendingUp className="h-4 w-4 text-navy/40" />
            <span className="text-xs font-semibold uppercase tracking-wider text-navy/50">Order Pipeline</span>
            <Link href="/orders" className="ml-auto flex items-center gap-1 text-xs text-brand-500 hover:underline">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="grid grid-cols-5 divide-x divide-surface-border">
            {[
              { label: "Pending", key: "PENDING" as const, color: "text-warning", bg: "bg-warning-bg" },
              { label: "Confirmed", key: "CONFIRMED" as const, color: "text-brand-600", bg: "bg-brand-50" },
              { label: "Out for Delivery", key: "OUT_FOR_DELIVERY" as const, color: "text-blue-600", bg: "bg-blue-50" },
              { label: "Delivered", key: "DELIVERED" as const, color: "text-success", bg: "bg-success-bg" },
              { label: "Cancelled", key: "CANCELLED" as const, color: "text-navy/60", bg: "" },
            ].map(({ label, key, color, bg }) => (
              <Link
                key={key}
                href={`/orders?status=${key}`}
                className={cn("flex flex-col items-center gap-1 px-3 py-4 text-center transition-colors hover:bg-surface-raised", bg && orderPipeline[key] > 0 && bg)}
              >
                <span className={cn("text-2xl font-bold", orderPipeline[key] > 0 ? color : "text-navy/20")}>
                  {orderPipeline[key]}
                </span>
                <span className="text-xs text-navy/50">{label}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Middle row: Urgent Orders + Driver Status ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* Left: Urgent Orders + Active Routes stacked */}
        <div className="flex flex-col gap-6 lg:col-span-2">

          {/* Urgent orders alert panel */}
          {urgentLoading ? (
            <div className="animate-pulse rounded-lg border border-surface-border bg-white p-5">
              <div className="h-4 w-48 rounded bg-navy/10" />
            </div>
          ) : urgentError ? (
            <ErrorBanner message="Could not load urgent orders." />
          ) : urgentOrders.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-danger/30 bg-danger-bg">
              <div className="flex items-center gap-2 border-b border-danger/20 bg-danger/10 px-4 py-3">
                <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
                <h2 className="text-sm font-semibold text-danger">
                  {urgentOrders.length} Urgent Order{urgentOrders.length !== 1 ? "s" : ""} Require Attention
                </h2>
              </div>
              <ul className="divide-y divide-danger/10">
                {urgentOrders.map((order) => (
                  <li key={order.id} className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-navy">
                        {order.customer?.businessName ?? "Unknown Customer"}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-navy/60">
                        <Clock className="h-3 w-3" />
                        {order.lineItems?.length ?? 0} items &middot; {timeAgo(order.createdAt)}
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
            <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success-bg px-4 py-5">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              <div>
                <p className="text-sm font-semibold text-success">All clear</p>
                <p className="mt-0.5 text-xs text-success/70">No urgent orders at this time.</p>
              </div>
            </div>
          )}

          {/* Scheduled route runs */}
          <Card title="Scheduled Route Runs">
            {runsLoading ? (
              <div className="animate-pulse space-y-3 py-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-10 rounded bg-navy/10" />
                ))}
              </div>
            ) : runsError ? (
              <ErrorBanner message="Could not load route runs." />
            ) : (
              <div className="-mx-6 -mb-6">
                <Table
                  data={activeRoutes}
                  columns={routeColumns}
                  onRowClick={(row) => router.push(`/routes/${row.original.id}`)}
                />
              </div>
            )}
          </Card>
        </div>

        {/* Right: Driver Status */}
        <div>
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
            ) : driversError ? (
              <ErrorBanner message="Could not load drivers." />
            ) : (
              <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                {drivers.length === 0 ? (
                  <li className="px-6 py-4 text-sm text-navy/50">No drivers found</li>
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
                        <p className="mt-0.5 text-xs text-navy/60">{driver.vehiclePlate ?? driver.user?.username}</p>
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
        </div>
      </div>

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
            <Table data={recentOrders} columns={orderColumns} />
          </div>
        )}
      </Card>

    </div>
  );
}
