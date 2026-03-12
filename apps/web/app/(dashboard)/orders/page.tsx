"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Eye, Loader2, Calendar, X } from "lucide-react";
import { PageHeader, Badge, Select, Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useOrders, type Order } from "@/lib/api/orders";
import { CreateOrderModal } from "./_components/CreateOrderModal";

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All Statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "CANCELLED", label: "Cancelled" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Orders"); }, [setTitle]);

  const statusParam = searchParams.get("status") ?? "";
  const [statusFilter, setStatusFilter] = React.useState(statusParam);
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [urgentOnly, setUrgentOnly] = React.useState(false);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);

  const { data, isLoading, isError } = useOrders({
    status: statusFilter || undefined,
    urgent: urgentOnly || undefined,
    deliveryDateFrom: dateFrom || undefined,
    deliveryDateTo: dateTo || undefined,
  });

  const orders = data?.data ?? [];

  const filtered = React.useMemo(() => {
    const q = customerSearch.toLowerCase();
    const list = orders.filter((o) => {
      if (q && !o.customer?.businessName?.toLowerCase().includes(q) && !o.orderNumber?.toLowerCase().includes(q)) return false;
      return true;
    });
    // Urgent orders float to top
    return [...list].sort((a, b) => {
      if (a.urgent && !b.urgent) return -1;
      if (!a.urgent && b.urgent) return 1;
      return 0;
    });
  }, [orders, customerSearch]);

  const urgentCount = orders.filter((o) => o.urgent).length;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Orders"
        action={
          <Button onClick={() => setIsCreateOpen(true)}>Create Order</Button>
        }
      />

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
          {urgentOnly && urgentCount > 0 && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white">
              {urgentCount}
            </span>
          )}
        </button>

        {/* Delivery date range filter */}
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/40" />
          <span className="text-xs text-navy/50 font-medium">Delivery:</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Delivery date from"
          />
          <span className="text-navy/40">–</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            min={dateFrom || undefined}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Delivery date to"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(""); setDateTo(""); }}
              className="rounded p-1.5 text-navy/40 hover:text-danger transition-colors"
              title="Clear dates"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Table — urgent rows get red left border via wrapper trick */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              <th className="w-4 px-3 py-3" />
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Order #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Items</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Total</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Delivery Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Created</th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/40" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load orders. Please try again.
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-sm text-navy/40">
                  No orders match your filters.{" "}
                  <button
                    className="text-brand-500 hover:underline"
                    onClick={() => { setCustomerSearch(""); setStatusFilter(""); setUrgentOnly(false); setDateFrom(""); setDateTo(""); }}
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
                    order.urgent && "border-l-2 border-l-danger",
                  )}
                >
                  <td className="px-3 py-3">
                    {order.urgent && (
                      <AlertTriangle className="h-4 w-4 text-danger" />
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                    {order.orderNumber}
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">
                    {order.customer?.businessName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-navy/70">{order.lineItems.length}</td>
                  <td className="px-4 py-3 font-medium text-navy">
                    ${Number(order.total).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-3">
                    <Badge status={order.status} />
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {order.requestedDeliveryDate ? (
                      <span className="font-medium text-navy">
                        {(() => { const [y,m,d] = order.requestedDeliveryDate.split('T')[0].split('-').map(Number); return new Date(y, m-1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); })()}
                      </span>
                    ) : (
                      <span className="text-navy/30">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-navy/60">
                    {new Date(order.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </td>
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

      <CreateOrderModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
      />
    </div>
  );
}
