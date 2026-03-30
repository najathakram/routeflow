"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/lib/page-title-context";
import { useCreateExpense, useExpenseCategories } from "@/lib/api/finance";
import { useSuppliers } from "@/lib/api/suppliers";
import { useToast } from "@routeflow/ui/web";

export default function NewExpensePage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("New Expense"); }, [setTitle]);
  const router = useRouter();
  const { toast } = useToast();
  const { data: categories } = useExpenseCategories();
  const { data: suppliersData } = useSuppliers();
  const createExpense = useCreateExpense();

  const [form, setForm] = React.useState({
    categoryId: "",
    supplierId: "",
    amount: "",
    date: new Date().toISOString().split("T")[0],
    description: "",
    paymentMethod: "CASH",
    notes: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.categoryId) { toast({ title: "Please select a category", variant: "error" }); return; }
    if (!form.amount || isNaN(Number(form.amount))) { toast({ title: "Please enter a valid amount", variant: "error" }); return; }
    try {
      await createExpense.mutateAsync({
        categoryId: form.categoryId,
        supplierId: form.supplierId || undefined,
        amount: Number(form.amount),
        date: form.date,
        description: form.description || undefined,
        paymentMethod: form.paymentMethod || undefined,
        notes: form.notes || undefined,
      });
      toast({ title: "Expense recorded", variant: "success" });
      router.push("/finance/expenses");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to record expense";
      const apiMessage = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast({ title: apiMessage ?? message, variant: "error" });
    }
  };

  const suppliers = suppliersData?.data ?? [];

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-navy">New Expense</h1>
        <p className="text-sm text-navy/60">Record a business expense</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-surface-border bg-white p-6">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-navy">Expense Category *</label>
            <select value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))} required className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">Select category...</option>
              {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy">Amount *</label>
            <input type="number" step="0.01" min="0" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required placeholder="0.00" className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy">Date *</label>
            <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy">Supplier / Vendor</label>
            <select value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))} className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">None</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy">Payment Method</label>
            <select value={form.paymentMethod} onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))} className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="CASH">Cash</option>
              <option value="CHECK">Check</option>
              <option value="ACH">ACH / Bank Transfer</option>
              <option value="CREDIT_CARD">Credit Card</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-navy">Description</label>
            <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What was this expense for?" className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <div className="col-span-2">
            <label className="mb-1.5 block text-sm font-medium text-navy">Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} placeholder="Additional notes..." className="w-full resize-none rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-surface-border pt-4">
          <button type="button" onClick={() => router.back()} className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy/60 hover:bg-surface-raised transition-colors">Cancel</button>
          <button type="submit" disabled={createExpense.isPending} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 transition-colors">
            {createExpense.isPending ? "Saving..." : "Record Expense"}
          </button>
        </div>
      </form>
    </div>
  );
}
