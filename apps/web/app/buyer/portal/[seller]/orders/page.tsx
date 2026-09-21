"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ShoppingCart, Loader2, AlertTriangle } from "lucide-react";
import { Badge } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerOrders } from "@/lib/api/buyer";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStatusVariant(status: string): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "DELIVERED":
    case "COMPLETED":
      return "success";
    case "PENDING":
    case "PROCESSING":
    case "IN_TRANSIT":
    case "CONFIRMED":
    case "OUT_FOR_DELIVERY":
      return "warning";
    case "CANCELLED":
    case "FAILED":
      return "danger";
    default:
      return "neutral";
  }
}

function formatStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatCurrency(amount?: number): string {
  if (amount === undefined || amount === null) return "N/A";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function orderLabel(order: { orderNumber?: string | null; id: string }): string {
  return order.orderNumber ?? order.id.slice(0, 8).toUpperCase();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerOrdersPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState("");
  const {
    data: result,
    isLoading,
    isError,
    error,
  } = useBuyerOrders({ page, limit: 20, status: statusFilter || undefined });

  // Validate slug matches active seller
  React.useEffect(() => {
    if (!authLoading && activeSeller && activeSeller.tenant.slug !== sellerSlug) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, sellerSlug, router]);

  // Redirect if no active seller after auth loads
  React.useEffect(() => {
    if (!authLoading && !activeSeller) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, router]);

  const orders = result?.data ?? [];
  const meta = result?.meta ?? null;

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-navy">Orders</h1>
        {activeSeller?.customer && (
          <p className="text-sm text-navy/70 mt-1">
            {activeSeller.customer.businessName} at {activeSeller.tenant.name}
          </p>
        )}
      </div>

      {/* Status filter tabs */}
      <div className="mb-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {[
          { label: "All", value: "" },
          { label: "Active", value: "PENDING" },
          { label: "Confirmed", value: "CONFIRMED" },
          { label: "Out for Delivery", value: "OUT_FOR_DELIVERY" },
          { label: "Delivered", value: "DELIVERED" },
          { label: "Cancelled", value: "CANCELLED" },
        ].map((tab) => (
          <button
            key={tab.value}
            onClick={() => {
              setStatusFilter(tab.value);
              setPage(1);
            }}
            className={`flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              statusFilter === tab.value
                ? "border-buyer-500 bg-buyer-500 text-white"
                : "border-surface-border bg-white text-navy/70 hover:border-buyer-300 hover:text-buyer-600"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {isError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {(error as any)?.response?.data?.message ?? "Failed to load orders."}
        </div>
      )}

      {/* Loading */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
        </div>
      ) : orders.length === 0 && !isError ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <ShoppingCart className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">No orders yet</h2>
          <p className="text-sm text-navy/70">Orders from this seller will appear here.</p>
        </div>
      ) : orders.length > 0 ? (
        <>
          {/* Card list — under 640px the 5-column table only scrolled sideways, so phones
              get one tappable card per order instead. */}
          <ul data-testid="buyer-orders-cards" className="space-y-3 sm:hidden">
            {orders.map((order: any) => (
              <li key={order.id}>
                <Link
                  href={`/buyer/portal/${sellerSlug}/orders/${order.id}`}
                  className="block rounded-xl border border-surface-border bg-white p-4 shadow-sm transition-colors hover:bg-surface-raised"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-semibold text-navy">
                      {orderLabel(order)}
                    </span>
                    <Badge
                      variant={getStatusVariant(order.status)}
                      label={formatStatus(order.status)}
                    />
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <p className="text-xs text-navy/70">
                      {formatDate(order.createdAt)}
                      {order.itemCount != null &&
                        ` · ${order.itemCount} item${order.itemCount !== 1 ? "s" : ""}`}
                    </p>
                    <span className="text-sm font-semibold text-navy">
                      {formatCurrency(Number(order.totalAmount ?? order.total))}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Table — from 640px up. The wrapper scrolls horizontally if a narrow tablet
              still cannot fit it; the Order # column stays pinned while it does. */}
          <div
            data-testid="buyer-orders-table"
            className="hidden overflow-hidden rounded-xl border border-surface-border bg-white shadow-sm sm:block"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="border-b border-surface-border bg-surface-raised">
                    <th className="sticky left-0 z-10 bg-surface-raised px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Order #
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Items
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {orders.map((order: any) => (
                    <tr
                      key={order.id}
                      onClick={() => router.push(`/buyer/portal/${sellerSlug}/orders/${order.id}`)}
                      className="group cursor-pointer transition-colors hover:bg-surface-raised"
                    >
                      <td className="sticky left-0 z-10 bg-white px-4 py-3 text-sm font-medium text-navy transition-colors group-hover:bg-surface-raised">
                        {orderLabel(order)}
                      </td>
                      <td className="px-4 py-3 text-sm text-navy/70">
                        {formatDate(order.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-navy/70">
                        {order.itemCount != null
                          ? `${order.itemCount} item${order.itemCount !== 1 ? "s" : ""}`
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={getStatusVariant(order.status)}
                          label={formatStatus(order.status)}
                        />
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-navy">
                        {formatCurrency(Number(order.totalAmount ?? order.total))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {meta && meta.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-navy/70">
                Showing {(meta.page - 1) * meta.limit + 1} to{" "}
                {Math.min(meta.page * meta.limit, meta.total)} of {meta.total}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={page === 1}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-white text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm text-navy">
                  Page {meta.page} of {meta.totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page === meta.totalPages}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-white text-navy/70 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
