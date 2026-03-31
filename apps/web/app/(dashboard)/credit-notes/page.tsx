"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Eye,
  Calendar,
  X,
  Loader2,
  FileText,
  Search,
} from "lucide-react";
import { PageHeader, Button, Select, cn, Modal, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useCreditNotes,
  useCreateCreditNote,
  type CreditNote,
  type CreditNoteStatus,
} from "@/lib/api/credit-notes";
import { useCustomers } from "@/lib/api/customers";
import { useInvoices } from "@/lib/api/invoices";
import { fmt, fmtDate } from "@/lib/formatting";

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<CreditNoteStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  ISSUED: "bg-blue-100 text-blue-700",
  APPLIED: "bg-green-100 text-green-700",
  VOID: "bg-red-100 text-red-600",
};

function CreditNoteStatusBadge({ status }: { status: CreditNoteStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        STATUS_COLORS[status],
      )}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

// ─── KPI chip ─────────────────────────────────────────────────────────────────

function KpiChip({
  label,
  value,
  danger,
  onClick,
  active,
}: {
  label: string;
  value: number;
  danger?: boolean;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-brand-500 bg-brand-500 text-white"
          : danger && value > 0
          ? "border-red-200 bg-red-50 text-red-700 hover:border-red-300"
          : "border-surface-border bg-white text-navy hover:bg-surface-raised",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-xs font-bold",
          active
            ? "bg-white/20 text-white"
            : danger && value > 0
            ? "bg-red-200 text-red-700"
            : "bg-surface-raised text-navy/60",
        )}
      >
        {value}
      </span>
    </button>
  );
}

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "ISSUED", label: "Issued" },
  { value: "APPLIED", label: "Applied" },
  { value: "VOID", label: "Void" },
];

// ─── Create Credit Note modal ─────────────────────────────────────────────────

interface CreateFormState {
  customerId: string;
  invoiceId: string;
  amount: string;
  reason: string;
  issueDate: string;
  notes: string;
}

const EMPTY_FORM: CreateFormState = {
  customerId: "",
  invoiceId: "",
  amount: "",
  reason: "",
  issueDate: new Date().toISOString().slice(0, 10),
  notes: "",
};

function CreateCreditNoteModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (id: string) => void;
}) {
  const { toast } = useToast();
  const createCreditNote = useCreateCreditNote();
  const [form, setForm] = React.useState<CreateFormState>(EMPTY_FORM);
  const [errors, setErrors] = React.useState<Partial<Record<keyof CreateFormState, string>>>({});
  const [customerSearch, setCustomerSearch] = React.useState("");

  const { data: customersData } = useCustomers({ search: customerSearch || undefined });
  const customers = customersData?.data ?? (Array.isArray(customersData) ? customersData : []);

  const { data: invoicesData } = useInvoices(
    form.customerId ? { limit: 100 } : undefined,
  );
  const invoices = React.useMemo(() => {
    const all = invoicesData?.data ?? [];
    return form.customerId ? all.filter((inv) => inv.customerId === form.customerId) : [];
  }, [invoicesData, form.customerId]);

  React.useEffect(() => {
    if (isOpen) {
      setForm(EMPTY_FORM);
      setErrors({});
      setCustomerSearch("");
    }
  }, [isOpen]);

  function validate() {
    const e: Partial<Record<keyof CreateFormState, string>> = {};
    if (!form.customerId) e.customerId = "Customer is required.";
    const amt = parseFloat(form.amount);
    if (!form.amount || isNaN(amt) || amt <= 0) e.amount = "Enter an amount greater than 0.";
    if (!form.reason.trim()) e.reason = "Reason is required.";
    if (!form.issueDate) e.issueDate = "Issue date is required.";
    return e;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setErrors({});

    createCreditNote.mutate(
      {
        customerId: form.customerId,
        invoiceId: form.invoiceId || undefined,
        amount: parseFloat(form.amount),
        reason: form.reason.trim(),
        issueDate: form.issueDate,
        notes: form.notes.trim() || undefined,
      },
      {
        onSuccess: (cn) => {
          toast({ title: "Credit note created", description: cn.creditNoteNumber, variant: "success" });
          onClose();
          onSuccess(cn.id);
        },
        onError: () => {
          toast({ title: "Failed to create credit note", description: "Please try again.", variant: "error" });
        },
      },
    );
  }

  const inputCls = (err?: string) =>
    cn(
      "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
      err ? "border-danger" : "border-surface-border",
    );

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="New Credit Note"
      description="Issue a credit note against an invoice or directly to a customer."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createCreditNote.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="create-cn-form" loading={createCreditNote.isPending}>
            Create Credit Note
          </Button>
        </>
      }
    >
      <form id="create-cn-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        {/* Customer */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Customer</label>
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/30" />
            <input
              type="search"
              placeholder="Search customers…"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              className="h-10 w-full rounded-lg border border-surface-border bg-white pl-9 pr-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <select
            value={form.customerId}
            onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value, invoiceId: "" }))}
            className={inputCls(errors.customerId)}
          >
            <option value="">Select customer…</option>
            {customers.map((c: { id: string; businessName: string }) => (
              <option key={c.id} value={c.id}>{c.businessName}</option>
            ))}
          </select>
          {errors.customerId && <p className="mt-1 text-xs text-danger">{errors.customerId}</p>}
        </div>

        {/* Invoice (optional) */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Invoice # <span className="text-navy/40">(optional)</span>
          </label>
          <select
            value={form.invoiceId}
            onChange={(e) => setForm((f) => ({ ...f, invoiceId: e.target.value }))}
            disabled={!form.customerId}
            className={cn(inputCls(), "disabled:opacity-50")}
          >
            <option value="">None</option>
            {invoices.map((inv) => (
              <option key={inv.id} value={inv.id}>{inv.invoiceNumber}</option>
            ))}
          </select>
        </div>

        {/* Amount */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Amount ($)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            className={inputCls(errors.amount)}
          />
          {errors.amount && <p className="mt-1 text-xs text-danger">{errors.amount}</p>}
        </div>

        {/* Reason */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Reason</label>
          <textarea
            rows={3}
            placeholder="Reason for credit note…"
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            className={cn(
              "w-full resize-none rounded-lg border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              errors.reason ? "border-danger" : "border-surface-border",
            )}
          />
          {errors.reason && <p className="mt-1 text-xs text-danger">{errors.reason}</p>}
        </div>

        {/* Issue Date */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Issue Date</label>
          <input
            type="date"
            value={form.issueDate}
            onChange={(e) => setForm((f) => ({ ...f, issueDate: e.target.value }))}
            className={inputCls(errors.issueDate)}
          />
          {errors.issueDate && <p className="mt-1 text-xs text-danger">{errors.issueDate}</p>}
        </div>

        {/* Notes */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Notes <span className="text-navy/40">(optional)</span>
          </label>
          <textarea
            rows={2}
            placeholder="Additional notes…"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CreditNotesPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Credit Notes"); }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [limit, setLimit] = React.useState(20);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);

  const { data, isLoading, isError } = useCreditNotes({
    status: statusFilter || undefined,
    search: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit,
  });

  const creditNotes = data?.data ?? [];
  const meta = data?.meta;

  const { data: allData } = useCreditNotes({ limit: 999 });
  const all = allData?.data ?? [];

  const kpiCounts = React.useMemo(() => {
    const counts = { total: all.length, draft: 0, issued: 0, applied: 0, void: 0 };
    for (const cn of all) {
      if (cn.status === "DRAFT") counts.draft++;
      if (cn.status === "ISSUED") counts.issued++;
      if (cn.status === "APPLIED") counts.applied++;
      if (cn.status === "VOID") counts.void++;
    }
    return counts;
  }, [all]);

  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Credit Notes"
        action={
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setIsCreateOpen(true)}
          >
            New Credit Note
          </Button>
        }
      />

      {/* KPI chips */}
      <div className="flex flex-wrap items-center gap-2">
        <KpiChip
          label="All"
          value={kpiCounts.total}
          active={statusFilter === ""}
          onClick={() => { setStatusFilter(""); setPage(1); }}
        />
        <KpiChip
          label="Draft"
          value={kpiCounts.draft}
          active={statusFilter === "DRAFT"}
          onClick={() => { setStatusFilter("DRAFT"); setPage(1); }}
        />
        <KpiChip
          label="Issued"
          value={kpiCounts.issued}
          active={statusFilter === "ISSUED"}
          onClick={() => { setStatusFilter("ISSUED"); setPage(1); }}
        />
        <KpiChip
          label="Applied"
          value={kpiCounts.applied}
          active={statusFilter === "APPLIED"}
          onClick={() => { setStatusFilter("APPLIED"); setPage(1); }}
        />
        <KpiChip
          label="Void"
          value={kpiCounts.void}
          danger
          active={statusFilter === "VOID"}
          onClick={() => { setStatusFilter("VOID"); setPage(1); }}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by CN # or customer…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-44">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          />
        </div>
        {/* Date range */}
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/40" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Issue date from"
          />
          <span className="text-navy/40">–</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Issue date to"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
              className="rounded p-1.5 text-navy/40 hover:text-danger transition-colors"
              title="Clear dates"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">CN #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Invoice #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Issue Date</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Amount</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Status</th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/40" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load credit notes. Please try again.
                </td>
              </tr>
            ) : creditNotes.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <FileText className="h-8 w-8 text-navy/20" />
                    <p className="text-sm text-navy/40">No credit notes match your filters.</p>
                    <button
                      className="text-sm text-brand-500 hover:underline"
                      onClick={() => {
                        setSearch("");
                        setStatusFilter("");
                        setDateFrom("");
                        setDateTo("");
                        setPage(1);
                      }}
                    >
                      Clear filters
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              creditNotes.map((cn: CreditNote) => (
                <tr
                  key={cn.id}
                  onClick={() => router.push(`/credit-notes/${cn.id}`)}
                  className="cursor-pointer transition-colors hover:bg-surface-raised"
                >
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                    {cn.creditNoteNumber}
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">
                    {cn.customer?.businessName ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-navy/60">
                    {cn.invoiceId ? <span className="text-brand-600">{cn.invoiceId}</span> : "—"}
                  </td>
                  <td className="px-4 py-3 text-navy/60">
                    {fmtDate((cn as any).issueDate ?? cn.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-navy">
                    {fmt(Number(cn.amount))}
                  </td>
                  <td className="px-4 py-3">
                    <CreditNoteStatusBadge status={cn.status} />
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="View credit note"
                      onClick={() => router.push(`/credit-notes/${cn.id}`)}
                      className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {meta && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <p className="text-sm text-navy/50">
              {meta.total > 0
                ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total} credit notes`
                : "No credit notes found"}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-navy/40">Per page:</span>
              <select
                value={limit}
                onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
                className="h-8 rounded border border-surface-border bg-white px-2 text-xs text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
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

      {/* Create modal */}
      <CreateCreditNoteModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(id) => router.push(`/credit-notes/${id}`)}
      />
    </div>
  );
}
