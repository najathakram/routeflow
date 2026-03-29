"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, CreditCard, ChevronDown } from "lucide-react";
import Link from "next/link";
import { Button, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useInvoicePayments, type AllPayment } from "@/lib/api/invoices";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function fmtDate(d?: string | null) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function methodLabel(method: string) {
  switch (method) {
    case "CASH": return "Cash";
    case "CHECK": return "Check";
    case "ACH": return "ACH";
    case "CREDIT_NOTE": return "Credit Note";
    case "ADVANCE": return "Advance";
    default: return method;
  }
}

function methodBadgeClass(method: string) {
  switch (method) {
    case "CREDIT_NOTE": return "bg-purple-100 text-purple-700";
    case "ADVANCE": return "bg-teal-100 text-teal-700";
    case "CASH": return "bg-green-100 text-green-700";
    case "CHECK": return "bg-blue-100 text-blue-700";
    case "ACH": return "bg-indigo-100 text-indigo-700";
    default: return "bg-gray-100 text-gray-600";
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PaymentsReceivedPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Payments Received"); }, [setTitle]);

  const [page, setPage] = React.useState(1);
  const LIMIT = 25;

  const { data, isLoading, isError } = useInvoicePayments({ page, limit: LIMIT });
  const payments: AllPayment[] = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-4 p-6">
      {/* Back */}
      <Link
        href="/invoices"
        className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Invoices
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-navy">All Received Payments</h1>
          <ChevronDown className="h-4 w-4 text-navy/50" />
        </div>
        <Button
          size="sm"
          leftIcon={<CreditCard className="h-4 w-4" />}
          onClick={() => router.push("/invoices")}
        >
          Record Payment
        </Button>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Date
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Payment #
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Customer Name
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Invoice #
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Mode
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">
                Amount
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/40" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load payments. Please try again.
                </td>
              </tr>
            ) : payments.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <CreditCard className="h-8 w-8 text-navy/20" />
                    <p className="text-sm text-navy/40">No payments recorded yet.</p>
                  </div>
                </td>
              </tr>
            ) : (
              payments.map((pmt, idx) => (
                <tr
                  key={pmt.id}
                  className="cursor-pointer transition-colors hover:bg-blue-50/40"
                  onClick={() => router.push(`/invoices/${pmt.invoice.id}`)}
                >
                  <td className="px-4 py-3 text-sm text-navy/60">
                    {fmtDate(pmt.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs font-semibold text-navy/70">
                      PMT-{String(idx + 1 + (page - 1) * LIMIT).padStart(4, "0")}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">
                    {pmt.invoice.customer?.businessName ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs font-semibold text-brand-500">
                      {pmt.invoice.invoiceNumber}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                        methodBadgeClass(pmt.method),
                      )}
                    >
                      {methodLabel(pmt.method)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-navy">
                    {fmt.format(Number(pmt.amount))}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                      Paid
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/50">
            Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total} payments
          </p>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              const p = i + 1;
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
        </div>
      )}
    </div>
  );
}
