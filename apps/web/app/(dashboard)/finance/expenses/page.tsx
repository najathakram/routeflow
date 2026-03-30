"use client";

import React from "react";
import Link from "next/link";
import { usePageTitle } from "@/lib/page-title-context";
import { useExpenses, useExpenseCategories, useDeleteExpense } from "@/lib/api/finance";
import { Plus, Trash2, Filter } from "lucide-react";
import { useToast } from "@routeflow/ui/web";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
const fmtDate = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function FinanceExpensesPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Expenses"); }, [setTitle]);
  const { toast } = useToast();
  const [page, setPage] = React.useState(1);
  const [categoryId, setCategoryId] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  const { data, isLoading } = useExpenses({ categoryId: categoryId || undefined, from: from || undefined, to: to || undefined, page, limit: 25 });
  const { data: categories } = useExpenseCategories();
  const deleteExpense = useDeleteExpense();

  const expenses = data?.data ?? [];
  const meta = data?.meta;
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

  const handleDelete = async (id: string) => {
    try {
      await deleteExpense.mutateAsync(id);
      toast({ title: "Expense deleted", variant: "success" });
      setConfirmDelete(null);
    } catch {
      toast({ title: "Failed to delete expense", variant: "error" });
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-navy">Expenses</h1>
          <p className="text-sm text-navy/60">Track and manage your business expenses</p>
        </div>
        <Link href="/finance/expenses/new" className="flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition-colors">
          <Plus className="h-4 w-4" /> New Expense
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-white p-4">
        <Filter className="h-4 w-4 text-navy/40" />
        <select value={categoryId} onChange={e => { setCategoryId(e.target.value); setPage(1); }} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="">All Categories</option>
          {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
        <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
        {(categoryId || from || to) && <button onClick={() => { setCategoryId(""); setFrom(""); setTo(""); setPage(1); }} className="text-xs text-navy/40 hover:text-danger transition-colors">Clear filters</button>}
        {!isLoading && meta && <span className="ml-auto text-sm text-navy/60">{meta.total} expenses &middot; {fmt(total)} total</span>}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-surface-border bg-white">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border bg-surface-raised">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Date</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Expense Account</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Description</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Supplier</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Payment Method</th>
                <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Amount</th>
                <th className="px-5 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {expenses.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-sm text-navy/40">No expenses found. <Link href="/finance/expenses/new" className="text-brand-500 hover:underline">Record your first expense.</Link></td></tr>
              )}
              {expenses.map((e) => (
                <tr key={e.id} className="group hover:bg-surface-raised/50 transition-colors">
                  <td className="px-5 py-3 text-navy/70">{fmtDate(e.date)}</td>
                  <td className="px-5 py-3 font-medium text-brand-600">{e.category.name}</td>
                  <td className="px-5 py-3 text-navy/70 max-w-xs truncate">{e.description ?? "—"}</td>
                  <td className="px-5 py-3 text-navy/70">{e.supplier?.name ?? "—"}</td>
                  <td className="px-5 py-3 text-navy/60 capitalize">{e.paymentMethod?.toLowerCase().replace("_", " ") ?? "—"}</td>
                  <td className="px-5 py-3 text-right font-semibold text-navy">{fmt(Number(e.amount))}</td>
                  <td className="px-5 py-3">
                    {confirmDelete === e.id ? (
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleDelete(e.id)} className="text-xs text-danger hover:underline">Delete</button>
                        <span className="text-navy/30">|</span>
                        <button onClick={() => setConfirmDelete(null)} className="text-xs text-navy/40 hover:underline">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmDelete(e.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-navy/30 hover:text-danger">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/60">Page {meta.page} of {meta.totalPages}</p>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised">Previous</button>
            <button onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))} disabled={page === meta.totalPages} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
