"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, Truck, ExternalLink } from "lucide-react";
import { Button, cn, EmptyState } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useClampPage } from "@/lib/hooks/useUrlPage";
import { useInvoices, type Invoice } from "@/lib/api/invoices";
import { fmtDate } from "@/lib/formatting";
import { carrierLabel, getTrackingUrl } from "@/lib/shipping";

// ─── Contextual status display (mirrors the invoices list) ────────────────────

function renderStatus(status: Invoice["status"]): React.ReactNode {
  const labels: Record<string, string> = {
    DRAFT: "Draft",
    SENT: "Sent",
    VIEWED: "Viewed",
    PARTIAL: "Partial",
    OVERDUE: "Overdue",
    PAID: "Paid",
    VOID: "Void",
    WRITTEN_OFF: "Written Off",
  };
  const colors: Record<string, string> = {
    DRAFT: "text-navy/50",
    SENT: "text-brand-600",
    VIEWED: "text-brand-700",
    PARTIAL: "text-warning",
    OVERDUE: "text-danger",
    PAID: "text-success",
    VOID: "text-navy/40",
    WRITTEN_OFF: "text-navy/50",
  };
  return (
    <span className={cn("text-xs font-semibold", colors[status] ?? "text-navy/50")}>
      {labels[status] ?? status}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ShipmentsPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Shipments");
  }, [setTitle]);

  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [page, setPage] = useUrlPage();
  const [limit, setLimit] = React.useState(20);

  // `shipped: true` returns only invoices that carry a tracking number; the
  // server-side search also matches tracking numbers.
  const { data, isLoading, isError } = useInvoices({
    shipped: true,
    search: debouncedSearch || undefined,
    page,
    limit,
  });

  const shipments = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;
  useClampPage(setPage, page, meta?.totalPages);

  return (
    <div className="space-y-4 p-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="h-5 w-5 text-navy/70" />
          <h2 className="text-xl font-bold text-navy">Shipments</h2>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search by tracking #, invoice # or customer…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="h-9 w-72 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                Customer
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                Invoice #
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                Carrier
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                Tracking #
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                Shipped
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                Status
              </th>
              <th className="w-16 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load shipments. Please try again.
                </td>
              </tr>
            ) : shipments.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-0">
                  <EmptyState
                    variant="custom"
                    icon={<Truck className="h-12 w-12" />}
                    title={search ? "No matching shipments" : "No shipments yet"}
                    description={
                      search
                        ? "No shipments match your search."
                        : "Add a carrier and tracking number to an invoice to see it here."
                    }
                    action={
                      search ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setSearch("");
                            setPage(1);
                          }}
                        >
                          Clear search
                        </Button>
                      ) : undefined
                    }
                  />
                </td>
              </tr>
            ) : (
              shipments.map((inv: Invoice) => {
                const trackUrl = getTrackingUrl(inv.shippingCarrier, inv.shippingTrackingNumber);
                return (
                  <tr
                    key={inv.id}
                    onClick={() => router.push(`/invoices/${inv.id}`)}
                    className="group cursor-pointer transition-colors hover:bg-blue-50/40"
                  >
                    <td className="px-4 py-3 font-medium text-navy">
                      {inv.customer?.businessName ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs font-semibold text-brand-500">
                        {inv.invoiceNumber}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-navy">
                      {carrierLabel(inv.shippingCarrier) || "—"}
                    </td>
                    <td className="px-4 py-3 text-sm" onClick={(e) => e.stopPropagation()}>
                      {trackUrl ? (
                        <a
                          href={trackUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 break-all text-brand-500 hover:underline"
                        >
                          {inv.shippingTrackingNumber}
                          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        </a>
                      ) : (
                        <span className="break-all text-navy/80">
                          {inv.shippingTrackingNumber ?? "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-navy">
                      {inv.shippedAt ? fmtDate(inv.shippedAt) : "—"}
                    </td>
                    <td className="px-4 py-3">{renderStatus(inv.status)}</td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        title="View invoice"
                        onClick={() => router.push(`/invoices/${inv.id}`)}
                        className="rounded p-1.5 text-navy/70 hover:bg-white hover:text-navy transition-colors"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {meta && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <p className="text-sm text-navy/70">
              {meta.total > 0
                ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total} shipments`
                : "No shipments found"}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-navy/70">Per page:</span>
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
                className="h-8 rounded border border-surface-border bg-white px-2 text-xs text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {meta.totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const p = totalPages <= 7 ? i + 1 : page <= 4 ? i + 1 : page + i - 3;
                if (p < 1 || p > totalPages) return null;
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={cn(
                      "rounded border px-3 py-1.5 text-sm font-medium transition-colors",
                      p === page
                        ? "border-brand-500 bg-brand-500 text-white"
                        : "border-surface-border bg-white text-navy hover:bg-surface-raised",
                    )}
                  >
                    {p}
                  </button>
                );
              })}
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
