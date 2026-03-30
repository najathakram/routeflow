"use client";

import React from "react";
import { usePageTitle } from "@/lib/page-title-context";
import { useInvoicePayments } from "@/lib/api/invoices";
import Link from "next/link";
import { fmt, fmtDate } from "@/lib/formatting";

const METHOD_LABELS: Record<string, string> = { CASH: "Cash", CHECK: "Check", ACH: "ACH", OTHER: "Other", CREDIT_NOTE: "Credit Note", ADVANCE: "Advance" };
const METHOD_COLORS: Record<string, string> = {
  CASH: "bg-success-bg text-success",
  CHECK: "bg-brand-50 text-brand-600",
  ACH: "bg-purple-50 text-purple-700",
  OTHER: "bg-surface-raised text-navy/60",
  CREDIT_NOTE: "bg-purple-100 text-purple-800",
  ADVANCE: "bg-teal-50 text-teal-700",
};

export default function FinancePaymentsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Payments Received"); }, [setTitle]);
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useInvoicePayments({ page, limit: 25 });

  const payments = data?.data ?? [];
  const meta = data?.meta;
  const total = payments.reduce((s, p) => s + p.amount, 0);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-navy">Payments Received</h1>
          <p className="text-sm text-navy/60">All payments recorded against invoices</p>
        </div>
        {meta && <p className="text-sm text-navy/60">{meta.total} total payments</p>}
      </div>

      {!isLoading && payments.length > 0 && (
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-navy/40">Total (this page)</p>
          <p className="mt-1 text-2xl font-bold text-success">{fmt(total)}</p>
        </div>
      )}

      <div className="rounded-xl border border-surface-border bg-white">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border bg-surface-raised">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Date</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Invoice #</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Customer</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Mode</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Reference</th>
                <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {payments.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-navy/40">No payments recorded yet</td></tr>
              )}
              {payments.map((p) => (
                <tr key={p.id} className="hover:bg-surface-raised/50 transition-colors">
                  <td className="px-5 py-3 text-navy/70">{fmtDate(p.createdAt)}</td>
                  <td className="px-5 py-3">
                    <Link href={`/invoices/${p.invoice.id}`} className="font-medium text-brand-600 hover:underline">{p.invoice.invoiceNumber}</Link>
                  </td>
                  <td className="px-5 py-3 text-navy">{p.invoice.customer?.businessName ?? "—"}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${METHOD_COLORS[p.method] ?? "bg-surface-raised text-navy/60"}`}>{METHOD_LABELS[p.method] ?? p.method}</span>
                  </td>
                  <td className="px-5 py-3 text-navy/60">{p.reference ?? "—"}</td>
                  <td className="px-5 py-3 text-right font-semibold text-success">{fmt(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/60">Page {meta.page} of {meta.totalPages} &middot; {meta.total} payments</p>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised">Previous</button>
            <button onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))} disabled={page === meta.totalPages} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
