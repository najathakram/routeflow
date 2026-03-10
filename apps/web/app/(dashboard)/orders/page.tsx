"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Eye } from "lucide-react";
import { PageHeader, Table, Badge, Select, Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { orders, orderTotal, type Order, type OrderStatus } from "@/mocks/orders";

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All Statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Orders"); }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [urgentOnly, setUrgentOnly] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = customerSearch.toLowerCase();
    const list = orders.filter((o) => {
      if (statusFilter && o.status !== statusFilter) return false;
      if (urgentOnly && !o.isUrgent) return false;
      if (q && !o.customerName.toLowerCase().includes(q) && !o.orderNumber.toLowerCase().includes(q)) return false;
      return true;
    });
    // Urgent orders float to top
    return [...list].sort((a, b) => {
      if (a.isUrgent && !b.isUrgent) return -1;
      if (!a.isUrgent && b.isUrgent) return 1;
      return 0;
    });
  }, [statusFilter, customerSearch, urgentOnly]);

  const columns = React.useMemo<ColumnDef<Order, unknown>[]>(
    () => [
      {
        id: "urgent",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.isUrgent ? (
            <AlertTriangle className="h-4 w-4 text-danger" title="Urgent" />
          ) : null,
      },
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
        accessorKey: "customerName",
        header: "Customer",
        cell: ({ row }) => (
          <span className="font-medium text-navy">{row.original.customerName}</span>
        ),
      },
      {
        accessorKey: "routeName",
        header: "Route",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-navy/60">{row.original.routeName ?? "—"}</span>
        ),
      },
      {
        id: "items",
        header: "Items",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-navy/70">{row.original.lineItems.length}</span>
        ),
      },
      {
        id: "total",
        header: "Total",
        cell: ({ row }) => (
          <span className="font-medium text-navy">
            ${orderTotal(row.original).toLocaleString("en-US", { minimumFractionDigits: 2 })}
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
        header: "Created",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-sm text-navy/60">{row.original.createdAt}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
            <button
              title="View order"
              onClick={() => router.push(`/orders/${row.original.id}`)}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
            >
              <Eye className="h-4 w-4" />
            </button>
          </div>
        ),
      },
    ],
    [router],
  );

  // Custom row class for urgent orders
  const urgentIds = new Set(filtered.filter((o) => o.isUrgent).map((o) => o.id));

  return (
    <div className="space-y-5 p-6">
      <PageHeader title="Orders" />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by customer or order #…"
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-48">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        {/* Urgent toggle */}
        <button
          onClick={() => setUrgentOnly((v) => !v)}
          className={cn(
            "flex h-10 items-center gap-2 rounded border px-3 text-sm font-medium transition-colors",
            urgentOnly
              ? "border-danger/40 bg-danger-bg text-danger"
              : "border-surface-border bg-white text-navy/60 hover:text-navy",
          )}
        >
          <AlertTriangle className="h-4 w-4" />
          Urgent only
          {urgentOnly && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white">
              {orders.filter((o) => o.isUrgent).length}
            </span>
          )}
        </button>
      </div>

      {/* Table — urgent rows get red left border via wrapper trick */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              {/* mirror column headers manually so we can add row-level left border */}
              <th className="w-4 px-3 py-3" />
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Order #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Route</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Items</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Total</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Created</th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-sm text-navy/40">
                  No orders match your filters.{" "}
                  <button
                    className="text-brand-500 hover:underline"
                    onClick={() => { setCustomerSearch(""); setStatusFilter(""); setUrgentOnly(false); }}
                  >
                    Clear filters
                  </button>
                </td>
              </tr>
            ) : (
              filtered.map((order) => (
                <tr
                  key={order.id}
                  onClick={() => router.push(`/orders/${order.id}`)}
                  className={cn(
                    "cursor-pointer transition-colors hover:bg-surface-raised",
                    order.isUrgent && "border-l-2 border-l-danger",
                  )}
                >
                  <td className="px-3 py-3">
                    {order.isUrgent && (
                      <AlertTriangle className="h-4 w-4 text-danger" title="Urgent" />
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                    {order.orderNumber}
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">{order.customerName}</td>
                  <td className="px-4 py-3 text-navy/60">{order.routeName ?? "—"}</td>
                  <td className="px-4 py-3 text-navy/70">{order.lineItems.length}</td>
                  <td className="px-4 py-3 font-medium text-navy">
                    ${orderTotal(order).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-3">
                    <Badge status={order.status} />
                  </td>
                  <td className="px-4 py-3 text-sm text-navy/60">{order.createdAt}</td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="View order"
                      onClick={() => router.push(`/orders/${order.id}`)}
                      className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
