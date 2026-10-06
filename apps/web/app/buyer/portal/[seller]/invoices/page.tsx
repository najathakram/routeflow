"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { Badge } from "@routeflow/ui/web";
import type { BuyerInvoiceListItem } from "@routeflow/types";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { invoiceStatusVariant } from "@/lib/buyer-invoice-status";
import { fmtCalendarDate, fmtDate } from "@/lib/formatting";

// ─── Types ────────────────────────────────────────────────────────────────────

// The row is the shared `BuyerInvoiceListItem` (GET /buyer/invoices): the amount is `total` and
// the balance is the server-derived `balanceDue` — there is no `totalAmount`/`amount`/`balance`
// (B1122: reading those printed "N/A" on every row).
interface PaginatedResponse {
  data: BuyerInvoiceListItem[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A money column arrives as a Decimal string today (`DecimalWire`), so coerce before formatting.
 *  "N/A" only when the API sent no amount at all. */
function formatCurrency(amount?: number | string | null): string {
  if (amount === undefined || amount === null || amount === "") return "N/A";
  const value = Number(amount);
  if (!Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerInvoicesPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const [invoices, setInvoices] = React.useState<BuyerInvoiceListItem[]>([]);
  const [meta, setMeta] = React.useState<PaginatedResponse["meta"] | null>(null);
  const [page, setPage] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

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

  // Fetch invoices
  React.useEffect(() => {
    if (authLoading || !activeSeller) return;
    if (activeSeller.tenant.slug !== sellerSlug) return;

    setIsLoading(true);
    setError(null);
    buyerApiClient
      .get<PaginatedResponse>("/buyer/invoices", { params: { page, limit: 20 } })
      .then((res) => {
        setInvoices(res.data.data);
        setMeta(res.data.meta);
      })
      .catch((err) => {
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Failed to load invoices.";
        setError(typeof msg === "string" ? msg : "Failed to load invoices.");
      })
      .finally(() => setIsLoading(false));
  }, [authLoading, activeSeller, sellerSlug, page]);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-buyer-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy">Invoices</h1>
        {activeSeller?.customer && (
          <p className="text-sm text-navy/70 mt-1">
            {activeSeller.customer.businessName} at {activeSeller.tenant.name}
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Loading */}
      {isLoading ? (
        <div
          data-testid="buyer-invoices-loading"
          role="status"
          aria-label="Loading invoices"
          className="flex items-center justify-center py-16"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-buyer-500 border-t-transparent" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <FileText className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">No invoices yet</h2>
          <p className="text-sm text-navy/70">Invoices from this seller will appear here.</p>
        </div>
      ) : (
        <>
          {/* Card list — under 640px the 6-column table scrolled sideways inside the viewport, so
              Status, Amount and Balance sat off-screen; phones get one tappable card per invoice
              instead (the orders list does the same). */}
          <ul data-testid="buyer-invoices-cards" className="space-y-3 sm:hidden">
            {invoices.map((invoice) => (
              <li key={invoice.id}>
                <Link
                  href={`/buyer/portal/${sellerSlug}/invoices/${invoice.id}`}
                  className="block rounded-xl border border-surface-border bg-white p-4 shadow-sm transition-colors hover:bg-surface-raised"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-semibold text-navy">
                      {invoice.invoiceNumber ?? invoice.id.slice(0, 8).toUpperCase()}
                    </span>
                    <Badge variant={invoiceStatusVariant(invoice.status)}>
                      {formatStatus(invoice.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-navy/70">
                    {fmtDate(invoice.createdAt)} · Due {fmtCalendarDate(invoice.dueDate)}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-surface-border pt-3">
                    <div>
                      <dt className="text-xs text-navy/70">Amount</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-navy">
                        {formatCurrency(invoice.total)}
                      </dd>
                    </div>
                    <div className="text-right">
                      <dt className="text-xs text-navy/70">Balance</dt>
                      <dd className="mt-0.5 text-sm font-semibold text-navy">
                        {formatCurrency(invoice.balanceDue)}
                      </dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>

          {/* Table — from 640px up. */}
          <div
            data-testid="buyer-invoices-table"
            className="hidden overflow-hidden rounded-xl border border-surface-border bg-white shadow-sm sm:block"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="border-b border-surface-border bg-surface-raised">
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Invoice #
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Due Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {invoices.map((invoice) => (
                    <tr
                      key={invoice.id}
                      onClick={() =>
                        router.push(`/buyer/portal/${sellerSlug}/invoices/${invoice.id}`)
                      }
                      className="hover:bg-surface-raised transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-navy">
                        {invoice.invoiceNumber ?? invoice.id.slice(0, 8).toUpperCase()}
                      </td>
                      <td className="px-4 py-3 text-sm text-navy/70">
                        {fmtDate(invoice.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-navy/70">
                        {fmtCalendarDate(invoice.dueDate)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={invoiceStatusVariant(invoice.status)}>
                          {formatStatus(invoice.status)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-navy">
                        {formatCurrency(invoice.total)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                        {formatCurrency(invoice.balanceDue)}
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
      )}
    </div>
  );
}
