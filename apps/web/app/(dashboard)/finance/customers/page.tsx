"use client";

import React from "react";
import Link from "next/link";
import { usePageTitle } from "@/lib/page-title-context";
import { useCustomerBalanceSummary } from "@/lib/api/finance";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { cn } from "@routeflow/ui/web";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);

export default function FinanceCustomersPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Customers"); }, [setTitle]);
  const { data, isLoading } = useCustomerBalanceSummary();

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" /></div>;
  }

  const customers = data?.data ?? [];
  const totalBalance = customers.reduce((s, c) => s + c.balance, 0);
  const totalOverdue = customers.reduce((s, c) => s + c.overdue, 0);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-navy">Customers</h1>
          <p className="text-sm text-navy/60">Outstanding balances and receivables by customer</p>
        </div>
        <Link href="/customers/new" className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition-colors">
          + New Customer
        </Link>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-navy/40">Total Outstanding</p>
          <p className="mt-1 text-2xl font-bold text-navy">{fmt(totalBalance)}</p>
        </div>
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-navy/40">Total Overdue</p>
          <p className={cn("mt-1 text-2xl font-bold", totalOverdue > 0 ? "text-danger" : "text-navy")}>{fmt(totalOverdue)}</p>
        </div>
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-navy/40">Customers with Balance</p>
          <p className="mt-1 text-2xl font-bold text-navy">{customers.length}</p>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-surface-border bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-border">
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Customer</th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Contact</th>
              <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Open Invoices</th>
              <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Outstanding</th>
              <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Overdue</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {customers.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-navy/40">No outstanding balances</td></tr>
            )}
            {customers.map((c) => (
              <tr key={c.customerId} className="hover:bg-surface-raised/50 transition-colors">
                <td className="px-5 py-3">
                  <Link href={`/customers/${c.customerId}`} className="font-medium text-brand-600 hover:underline">{c.businessName}</Link>
                </td>
                <td className="px-5 py-3 text-navy/60">{c.contactName ?? "—"}</td>
                <td className="px-5 py-3 text-right text-navy">{c.invoiceCount}</td>
                <td className="px-5 py-3 text-right font-medium text-navy">{fmt(c.balance)}</td>
                <td className="px-5 py-3 text-right">
                  {c.overdue > 0 ? (
                    <span className="flex items-center justify-end gap-1 text-danger font-medium">
                      <AlertTriangle className="h-3.5 w-3.5" />{fmt(c.overdue)}
                    </span>
                  ) : <span className="text-navy/40">—</span>}
                </td>
                <td className="px-5 py-3">
                  <Link href={`/invoices?customerId=${c.customerId}`} className="flex items-center justify-end gap-1 text-xs text-brand-500 hover:underline">
                    View Invoices <ArrowRight className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
