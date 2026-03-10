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
} from "lucide-react";
import { StatCard, Badge, Table, Button, Card, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  kpi,
  urgentOrders,
  activeRoutes,
  drivers,
  recentOrders,
  type ActiveRoute,
  type RecentOrder,
} from "@/mocks/dashboard";

// ─── Column definitions (stable refs, defined outside component) ───────────────

const routeColumns: ColumnDef<ActiveRoute, unknown>[] = [
  {
    accessorKey: "name",
    header: "Route Name",
    cell: ({ row }) => (
      <span className="font-medium text-navy">{row.original.name}</span>
    ),
  },
  {
    accessorKey: "driver",
    header: "Driver",
    cell: ({ row }) => (
      <span className="text-navy/70">{row.original.driver}</span>
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
    cell: ({ row }) => (
      <span className="text-sm text-navy/70">
        {row.original.stopsDone} / {row.original.stopsTotal}
      </span>
    ),
  },
  {
    accessorKey: "startTime",
    header: "Start Time",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-navy/70">{row.original.startTime}</span>
    ),
  },
];

const orderColumns: ColumnDef<RecentOrder, unknown>[] = [
  {
    accessorKey: "orderNumber",
    header: "Order #",
    cell: ({ row }) => (
      <span className="font-mono text-xs font-semibold text-navy">
        {row.original.orderNumber}
      </span>
    ),
  },
  {
    accessorKey: "customer",
    header: "Customer",
    cell: ({ row }) => (
      <span className="text-navy">{row.original.customer}</span>
    ),
  },
  {
    accessorKey: "items",
    header: "Items",
    cell: ({ row }) => (
      <span className="text-navy/70">{row.original.items}</span>
    ),
  },
  {
    accessorKey: "total",
    header: "Total",
    cell: ({ row }) => (
      <span className="font-medium text-navy">
        ${row.original.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
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
    accessorKey: "date",
    header: "Date",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-navy/60">{row.original.date}</span>
    ),
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimeAgo(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();

  React.useEffect(() => {
    setTitle("Dashboard");
  }, [setTitle]);

  return (
    <div className="space-y-6 p-6">

      {/* ── KPI stat cards ── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Active Orders"
          value={kpi.activeOrders}
          trend={8}
          trendLabel="vs last week"
          icon={<ShoppingCart className="h-5 w-5" />}
        />
        <StatCard
          label="Routes Today"
          value={kpi.routesToday}
          icon={<MapPin className="h-5 w-5" />}
        />
        <StatCard
          label="Drivers On Road"
          value={kpi.driversOnRoad}
          icon={<Truck className={cn("h-5 w-5", kpi.driversOnRoad > 0 && "text-success")} />}
          className={kpi.driversOnRoad > 0 ? "ring-1 ring-inset ring-success/20" : ""}
        />
        <StatCard
          label="Low Stock Items"
          value={kpi.lowStockItems}
          icon={
            <AlertTriangle
              className={cn("h-5 w-5", kpi.lowStockItems > 0 ? "text-danger" : "")}
            />
          }
          className={kpi.lowStockItems > 0 ? "ring-1 ring-inset ring-danger/20" : ""}
        />
      </div>

      {/* ── Middle row: Urgent Orders + Driver Status ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* Left: Urgent Orders + Active Routes stacked */}
        <div className="flex flex-col gap-6 lg:col-span-2">

          {/* Urgent orders alert panel */}
          {urgentOrders.length > 0 ? (
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
                        {order.customer}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-navy/60">
                        <Clock className="h-3 w-3" />
                        {order.itemsCount} items &middot; {formatTimeAgo(order.minutesAgo)}
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

          {/* Active route runs */}
          <Card title="Active Route Runs">
            <div className="-mx-6 -mb-6">
              <Table
                data={activeRoutes}
                columns={routeColumns}
                onRowClick={(row) => router.push(`/routes/${row.original.id}`)}
              />
            </div>
          </Card>
        </div>

        {/* Right: Driver Status */}
        <div>
          <Card title="Driver Status">
            <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
              {drivers.map((driver) => (
                <li key={driver.id} className="flex items-start gap-3 px-6 py-4">
                  <span
                    className={cn(
                      "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                      driver.onlineStatus === "on_route" ? "bg-success" : "bg-navy/20",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-navy">{driver.name}</p>
                    {driver.currentRoute ? (
                      <p className="mt-0.5 truncate text-xs text-navy/60">
                        {driver.currentRoute}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-xs text-navy/40">Idle</p>
                    )}
                    <p className="mt-0.5 text-xs text-navy/40">{driver.lastPing}</p>
                  </div>
                  <Badge
                    variant={driver.onlineStatus === "on_route" ? "success" : "neutral"}
                    label={driver.onlineStatus === "on_route" ? "On Route" : "Idle"}
                  />
                </li>
              ))}
            </ul>
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
        <div className="-mx-6 -mb-6">
          <Table data={recentOrders} columns={orderColumns} />
        </div>
      </Card>

    </div>
  );
}
