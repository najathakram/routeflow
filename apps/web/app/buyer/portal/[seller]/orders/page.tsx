"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  ShoppingCart,
  Loader2,
  AlertTriangle,
} from "lucide-react";
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
  if (amount === undefined || amount === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerOrdersPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const [page, setPage] = React.useState(1);
  const { data: result, isLoading, isError, error } = useBuyerOrders({ page, limit: 20 });

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
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy">Orders</h1>
        {activeSeller && (
          <p className="text-sm text-navy/60 mt-1">
            {activeSeller.customer.businessName} at {activeSeller.tenant.name}
          </p>
        )}
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
          <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
        </div>
      ) : orders.length === 0 && !isError ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <ShoppingCart className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">No orders yet</h2>
          <p className="text-sm text-navy/60">Orders from this seller will appear here.</p>
        </div>
      ) : orders.length > 0 ? (
        <>
          {/* Table */}
          <div className="overflow-hidden rounded-xl border border-surface-border bg-white shadow-sm">
            <table className="w-full">
              <thead>
                <tr className="border-b border-surface-border bg-surface-raised">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/50">
                    Order #
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/50">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/50">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/50">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {orders.map((order: any) => (
                  <tr
                    key={order.id}
                    onClick={() => router.push(`/buyer/portal/${sellerSlug}/orders/${order.id}`)}
                    className="hover:bg-surface-raised transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3 text-sm font-medium text-navy">
                      {order.orderNumber ?? order.id.slice(0, 8).toUpperCase()}
                    </td>
                    <td className="px-4 py-3 text-sm text-navy/70">
                      {formatDate(order.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={getStatusVariant(order.status)}>
                        {formatStatus(order.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-navy">
                      {formatCurrency(Number(order.totalAmount ?? order.total))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {meta && meta.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-navy/60">
                Showing {(meta.page - 1) * meta.limit + 1}–
                {Math.min(meta.page * meta.limit, meta.total)} of {meta.total}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={page === 1}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-white text-navy/60 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border bg-white text-navy/60 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
