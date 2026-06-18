"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useInvoicePayments,
  useVoidPayment,
  useExportPayments,
  useRecordPaymentStandalone,
  type PaymentListParams,
  type StandalonePaymentDto,
} from "@/lib/api/invoices";
import { useInvoices } from "@/lib/api/invoices";
import { useCustomers } from "@/lib/api/customers";
import { useToast, EmptyState, Button } from "@routeflow/ui/web";
import Link from "next/link";
import { fmt, fmtDate } from "@/lib/formatting";

// ─── Constants ─────────────────────────────────────────────────────────────────

const METHOD_LABELS: Record<string, string> = {
  CASH: "Cash",
  CHECK: "Check",
  ACH: "ACH / Bank Transfer",
  CREDIT_CARD: "Credit Card",
  OTHER: "Other",
  CREDIT_NOTE: "Credit Note",
  ADVANCE: "Advance",
};
const METHOD_COLORS: Record<string, string> = {
  CASH: "bg-success-bg text-success",
  CHECK: "bg-brand-50 text-brand-600",
  ACH: "bg-indigo-50 text-indigo-700",
  CREDIT_CARD: "bg-orange-50 text-orange-700",
  OTHER: "bg-surface-raised text-navy/70",
  CREDIT_NOTE: "bg-purple-100 text-purple-800",
  ADVANCE: "bg-teal-50 text-teal-700",
};
const STATUS_STYLES: Record<string, string> = {
  PAID: "bg-success-bg text-success",
  DRAFT: "bg-warning-bg text-warning",
  VOID: "bg-surface-raised text-navy/70 line-through",
};

const fieldCls =
  "w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

// ─── Sort helper ───────────────────────────────────────────────────────────────

function SortIcon({ col, sortBy, sortDir }: { col: string; sortBy: string; sortDir: string }) {
  if (sortBy !== col) return <span className="ml-1 text-navy/30">⇅</span>;
  return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

// ─── Record Payment Modal ──────────────────────────────────────────────────────

interface Allocation {
  invoiceId: string;
  amount: string;
  invoiceNumber: string;
  amountDue: number;
}

function RecordPaymentModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const record = useRecordPaymentStandalone();
  const { data: customersData } = useCustomers({ limit: 200 });
  const [customerId, setCustomerId] = React.useState("");
  const [totalAmount, setTotalAmount] = React.useState("");
  const [bankCharges, setBankCharges] = React.useState("");
  const [paidAt, setPaidAt] = React.useState(new Date().toISOString().split("T")[0]);
  const [method, setMethod] = React.useState("CASH");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [allocations, setAllocations] = React.useState<Allocation[]>([]);

  const { data: invoicesData } = useInvoices({
    status: "SENT,VIEWED,PARTIAL,OVERDUE",
    page: 1,
    limit: 50,
  });

  const customerInvoices = React.useMemo(() => {
    if (!customerId || !invoicesData?.data) return [];
    return invoicesData.data.filter(
      (inv) => inv.customerId === customerId && inv.balanceDue && inv.balanceDue > 0,
    );
  }, [customerId, invoicesData, invoicesData?.data]);

  // When customer changes, reset allocations and pre-fill greedily
  React.useEffect(() => {
    if (!customerId || !customerInvoices.length) {
      setAllocations([]);
      return;
    }
    let remaining = parseFloat(totalAmount) || 0;
    const allocs: Allocation[] = customerInvoices.map((inv) => {
      const due = inv.balanceDue ?? 0;
      const apply = Math.min(remaining, due);
      remaining -= apply;
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amountDue: due,
        amount: apply > 0 ? apply.toFixed(2) : "",
      };
    });
    setAllocations(allocs);
  }, [customerId, customerInvoices.length, totalAmount]);

  const allocatedTotal = allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  const total = parseFloat(totalAmount) || 0;
  const excess = Math.max(0, total - allocatedTotal);

  const updateAlloc = (idx: number, val: string) =>
    setAllocations((prev) => prev.map((a, i) => (i === idx ? { ...a, amount: val } : a)));

  const customers = customersData?.data ?? [];

  const handleSave = async (status: "DRAFT" | "PAID") => {
    if (!customerId) {
      toast({ title: "Select a customer", variant: "error" });
      return;
    }
    if (!total || total <= 0) {
      toast({ title: "Enter a valid amount", variant: "error" });
      return;
    }
    const validAllocs = allocations.filter((a) => a.amount && parseFloat(a.amount) > 0);
    const dto: StandalonePaymentDto = {
      customerId,
      totalAmount: total,
      method: method as any,
      paidAt,
      bankCharges: bankCharges ? parseFloat(bankCharges) : undefined,
      reference: reference || undefined,
      notes: notes || undefined,
      status,
      allocations: validAllocs.map((a) => ({
        invoiceId: a.invoiceId,
        amount: parseFloat(a.amount),
      })),
    };
    try {
      await record.mutateAsync(dto);
      toast({
        title: `Payment ${status === "DRAFT" ? "saved as draft" : "recorded"}`,
        variant: "success",
      });
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast({ title: msg ?? "Failed to record payment", variant: "error" });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-modal flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-lg font-semibold text-navy">Record Payment</h2>
          <button onClick={onClose} className="text-navy/70 hover:text-navy text-xl">
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {/* Customer */}
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-navy">Customer *</label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className={fieldCls}
              >
                <option value="">Select customer...</option>
                {customers.map((c: { id: string; businessName: string }) => (
                  <option key={c.id} value={c.id}>
                    {c.businessName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">
                Amount Received *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                placeholder="0.00"
                className={fieldCls}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Bank Charges</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={bankCharges}
                onChange={(e) => setBankCharges(e.target.value)}
                placeholder="0.00"
                className={fieldCls}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Payment Date *</label>
              <input
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Payment Mode *</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className={fieldCls}
              >
                <option value="CASH">Cash</option>
                <option value="CHECK">Check</option>
                <option value="ACH">ACH / Bank Transfer</option>
                <option value="CREDIT_CARD">Credit Card</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Reference #</label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Check #, transaction ID..."
                className={fieldCls}
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-navy">Notes (internal)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className={`${fieldCls} resize-none`}
                placeholder="Internal notes..."
              />
            </div>
          </div>

          {/* Invoice allocation */}
          {customerId && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-navy">Apply to Invoices</h3>
                <button
                  type="button"
                  onClick={() => setAllocations((prev) => prev.map((a) => ({ ...a, amount: "" })))}
                  className="text-xs text-brand-500 hover:underline"
                >
                  Clear
                </button>
              </div>
              {customerInvoices.length === 0 ? (
                <p className="text-sm text-navy/70 italic">No unpaid invoices for this customer.</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-surface-border">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-raised text-xs font-medium text-navy/70">
                      <tr>
                        <th className="px-3 py-2 text-left">Invoice #</th>
                        <th className="px-3 py-2 text-right">Amount Due</th>
                        <th className="px-3 py-2 text-right">Apply ($)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border">
                      {allocations.map((a, idx) => (
                        <tr key={a.invoiceId}>
                          <td className="px-3 py-2 font-medium text-brand-600">
                            {a.invoiceNumber}
                          </td>
                          <td className="px-3 py-2 text-right text-navy">{fmt(a.amountDue)}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              max={a.amountDue}
                              value={a.amount}
                              onChange={(e) => updateAlloc(idx, e.target.value)}
                              className="w-28 rounded border border-surface-border px-2 py-1 text-right text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-3 space-y-1 text-sm text-right">
                <div className="flex justify-between text-navy/70">
                  <span>Allocated:</span>
                  <span>{fmt(allocatedTotal)}</span>
                </div>
                <div className="flex justify-between text-navy/70">
                  <span>Total received:</span>
                  <span>{fmt(total)}</span>
                </div>
                {excess > 0.001 && (
                  <div className="flex justify-between font-medium text-amber-600">
                    <span>⚠ Unallocated (→ advance):</span>
                    <span>{fmt(excess)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-surface-border px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy/70 hover:bg-surface-raised"
          >
            Cancel
          </button>
          <button
            onClick={() => handleSave("DRAFT")}
            disabled={record.isPending}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy hover:bg-surface-raised disabled:opacity-50"
          >
            Save as Draft
          </button>
          <button
            onClick={() => handleSave("PAID")}
            disabled={record.isPending}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {record.isPending ? "Saving..." : "Save as Paid"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function FinancePaymentsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Payments Received");
  }, [setTitle]);
  const router = useRouter();
  const { toast } = useToast();

  // Filters + sort state
  const [search, setSearch] = React.useState("");
  const [method, setMethod] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [customerId, setCustomerId] = React.useState("");
  const [sortBy, setSortBy] = React.useState("paidAt");
  const [sortDir, setSortDir] = React.useState("desc");
  const [page, setPage] = React.useState(1);
  const [showModal, setShowModal] = React.useState(false);
  const [voidConfirm, setVoidConfirm] = React.useState<{
    invoiceId: string;
    paymentId: string;
  } | null>(null);

  const params: PaymentListParams = {
    page,
    limit: 25,
    search: search || undefined,
    method: method || undefined,
    status: status || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    customerId: customerId || undefined,
    sortBy,
    sortDir,
  };

  const { data, isLoading } = useInvoicePayments(params);
  const { data: customersData } = useCustomers({ limit: 200 });
  const voidPayment = useVoidPayment();
  const exportPayments = useExportPayments();

  const payments = data?.data ?? [];
  const meta = data?.meta;
  const summary = data?.summary;
  const customers = customersData?.data ?? [];

  const toggleSort = (col: string) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortDir("desc");
    }
    setPage(1);
  };

  const handleVoid = async () => {
    if (!voidConfirm) return;
    try {
      await voidPayment.mutateAsync(voidConfirm);
      toast({ title: "Payment voided", variant: "success" });
      setVoidConfirm(null);
    } catch {
      toast({ title: "Failed to void payment", variant: "error" });
    }
  };

  const handleExport = async () => {
    try {
      await exportPayments.mutateAsync(params);
    } catch {
      toast({ title: "Export failed", variant: "error" });
    }
  };

  // Reset page when filters change
  React.useEffect(() => {
    setPage(1);
  }, [search, method, status, dateFrom, dateTo, customerId]);

  // Keyboard shortcut: / to focus search
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        document.getElementById("payments-search")?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="space-y-6 p-6">
      {showModal && <RecordPaymentModal onClose={() => setShowModal(false)} />}

      {/* Void confirm */}
      {voidConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-modal space-y-4">
            <h3 className="text-lg font-semibold text-navy">Void Payment?</h3>
            <p className="text-sm text-navy/70">
              This will mark the payment as void and reverse its effect on the invoice. This cannot
              be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setVoidConfirm(null)}
                className="rounded-lg border border-surface-border px-4 py-2 text-sm text-navy/70 hover:bg-surface-raised"
              >
                Cancel
              </button>
              <button
                onClick={handleVoid}
                disabled={voidPayment.isPending}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50"
              >
                {voidPayment.isPending ? "Voiding..." : "Void Payment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-navy">Payments Received</h1>
          <p className="text-sm text-navy/70">All payments recorded against invoices</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition-colors"
        >
          + Record Payment
        </button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-surface-border bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-navy/70">
              Total Received
            </p>
            <p className="mt-1 text-2xl font-bold text-success">{fmt(summary.totalReceived)}</p>
            <p className="text-xs text-navy/70 mt-0.5">{summary.count} payments</p>
          </div>
          <div className="rounded-xl border border-surface-border bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-navy/70">
              Filtered Count
            </p>
            <p className="mt-1 text-2xl font-bold text-navy">{meta?.total ?? 0}</p>
            <p className="text-xs text-navy/70 mt-0.5">matching current filters</p>
          </div>
          <div className="rounded-xl border border-surface-border bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-navy/70">
              Advance Balance
            </p>
            <p
              className={`mt-1 text-2xl font-bold ${summary.advanceBalance > 0 ? "text-warning" : "text-navy"}`}
            >
              {fmt(summary.advanceBalance)}
            </p>
            <p className="text-xs text-navy/70 mt-0.5">unallocated advance funds</p>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="rounded-xl border border-surface-border bg-white p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-center">
          <input
            id="payments-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search payment #, reference, customer... (/)"
            className="w-64 rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="From date"
          />
          <span className="text-navy/70 text-sm">–</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="To date"
          />
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All Methods</option>
            <option value="CASH">Cash</option>
            <option value="CHECK">Check</option>
            <option value="ACH">ACH / Bank Transfer</option>
            <option value="CREDIT_CARD">Credit Card</option>
            <option value="OTHER">Other</option>
            <option value="CREDIT_NOTE">Credit Note</option>
            <option value="ADVANCE">Advance</option>
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All Statuses</option>
            <option value="PAID">Paid</option>
            <option value="DRAFT">Draft</option>
            <option value="VOID">Void</option>
          </select>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All Customers</option>
            {customers.map((c: { id: string; businessName: string }) => (
              <option key={c.id} value={c.id}>
                {c.businessName}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              setSearch("");
              setMethod("");
              setStatus("");
              setDateFrom("");
              setDateTo("");
              setCustomerId("");
            }}
            className="text-sm text-navy/70 hover:text-navy underline"
          >
            Clear
          </button>
          <button
            onClick={handleExport}
            disabled={exportPayments.isPending}
            className="ml-auto rounded-lg border border-surface-border px-3 py-2 text-sm text-navy/70 hover:bg-surface-raised transition-colors disabled:opacity-50"
          >
            {exportPayments.isPending ? "Exporting..." : "⬇ Export CSV"}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border bg-surface-raised">
                <th
                  onClick={() => toggleSort("paidAt")}
                  className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                >
                  Date <SortIcon col="paidAt" sortBy={sortBy} sortDir={sortDir} />
                </th>
                <th
                  onClick={() => toggleSort("paymentNumber")}
                  className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                >
                  Payment # <SortIcon col="paymentNumber" sortBy={sortBy} sortDir={sortDir} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Invoice(s)</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Customer</th>
                <th
                  onClick={() => toggleSort("method")}
                  className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                >
                  Mode <SortIcon col="method" sortBy={sortBy} sortDir={sortDir} />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Reference</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Status</th>
                <th
                  onClick={() => toggleSort("amount")}
                  className="px-4 py-3 text-right text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                >
                  Amount <SortIcon col="amount" sortBy={sortBy} sortDir={sortDir} />
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {payments.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-0">
                    {search || method || status || dateFrom || dateTo || customerId ? (
                      <EmptyState
                        variant="invoices"
                        title="No matching payments"
                        description="No payments match your current search and filters."
                        action={
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setSearch("");
                              setMethod("");
                              setStatus("");
                              setDateFrom("");
                              setDateTo("");
                              setCustomerId("");
                            }}
                          >
                            Clear filters
                          </Button>
                        }
                      />
                    ) : (
                      <EmptyState
                        variant="invoices"
                        title="No payments yet"
                        description="Record a payment to mark invoices as paid and track receipts."
                        action={
                          <Button size="sm" onClick={() => setShowModal(true)}>
                            Record payment
                          </Button>
                        }
                      />
                    )}
                  </td>
                </tr>
              )}
              {payments.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => router.push(`/finance/payments/${p.id}`)}
                  className={`cursor-pointer hover:bg-surface-raised/50 transition-colors ${p.status === "VOID" ? "opacity-50" : ""}`}
                >
                  <td className="px-4 py-3 text-navy">{fmtDate(p.paidAt ?? p.createdAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-navy">
                    {p.paymentNumber ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/invoices/${p.invoice.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-brand-600 hover:underline"
                    >
                      {p.invoice.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-navy">{p.invoice.customer?.businessName ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${METHOD_COLORS[p.method] ?? "bg-surface-raised text-navy/70"}`}
                    >
                      {METHOD_LABELS[p.method] ?? p.method}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-navy/70">{p.reference ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[p.status ?? "PAID"] ?? STATUS_STYLES.PAID}`}
                    >
                      {p.status ?? "PAID"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-success">
                    {fmt(p.amount)}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="relative group inline-block">
                      <button className="rounded-lg border border-surface-border px-2 py-1 text-xs text-navy/70 hover:bg-surface-raised">
                        ⋮
                      </button>
                      <div className="absolute right-0 top-7 z-10 hidden group-focus-within:block bg-white border border-surface-border rounded-lg shadow-dropdown min-w-[140px] py-1">
                        <button
                          onClick={() => router.push(`/finance/payments/${p.id}`)}
                          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-raised"
                        >
                          View Receipt
                        </button>
                        <Link
                          href={`/invoices/${p.invoice.id}`}
                          className="block px-3 py-1.5 text-sm hover:bg-surface-raised"
                        >
                          View Invoice
                        </Link>
                        {p.status !== "VOID" && (
                          <button
                            onClick={() =>
                              setVoidConfirm({ invoiceId: p.invoice.id, paymentId: p.id })
                            }
                            className="block w-full px-3 py-1.5 text-left text-sm text-danger hover:bg-danger-bg"
                          >
                            Void
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            Page {meta.page} of {meta.totalPages} · {meta.total} payments
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page === meta.totalPages}
              className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
