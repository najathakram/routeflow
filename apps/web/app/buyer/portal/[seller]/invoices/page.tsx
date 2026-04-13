"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { Badge } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { buyerApiClient } from "@/lib/buyer-api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Invoice {
  id: string;
  invoiceNumber?: string;
  createdAt: string;
  dueDate?: string;
  status: string;
  totalAmount?: number;
  amount?: number;
  balanceDue?: number;
  balance?: number;
}

interface PaginatedResponse {
  data: Invoice[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStatusVariant(status: string): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "PAID":
      return "success";
    case "PENDING":
    case "SENT":
    case "PARTIALLY_PAID":
      return "warning";
    case "OVERDUE":
    case "CANCELLED":
    case "VOID":
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

function formatDate(dateStr?: string): string {
  if (!dateStr) return "—";
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

export default function BuyerInvoicesPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  const [invoices, setInvoices] = React.useState<Invoice[]>([]);
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
        {activeSeller && (
          <p className="text-sm text-navy/60 mt-1">
            {activeSeller.customer.businessName} at {activeSeller.tenant.name}
          </p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Loading */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-buyer-500 border-t-transparent" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <FileText className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">No invoices yet</h2>
          <p className="text-sm text-navy/60">Invoices from this seller will appear here.</p>
        </div>
      ) : (
        <>
          {/* Table */}
          <div className="overflow-hidden rounded-xl border border-surface-border bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="border-b border-surface-border bg-surface-raised">
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/50">
                      Invoice #
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/50">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/50">
                      Due Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/50">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/50">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/50">
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {invoices.map((invoice) => (
                    <tr
                      key={invoice.id}
                      onClick={() => router.push(`/buyer/portal/${sellerSlug}/invoices/${invoice.id}`)}
                      className="hover:bg-surface-raised transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-navy">
                        {invoice.invoiceNumber ?? invoice.id.slice(0, 8).toUpperCase()}
                      </td>
                      <td className="px-4 py-3 text-sm text-navy/70">
                        {formatDate(invoice.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-navy/70">
                        {formatDate(invoice.dueDate)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={getStatusVariant(invoice.status)}>
                          {formatStatus(invoice.status)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-navy">
                        {formatCurrency(invoice.totalAmount ?? invoice.amount)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                        {formatCurrency(invoice.balanceDue ?? invoice.balance)}
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
      )}
    </div>
  );
}
