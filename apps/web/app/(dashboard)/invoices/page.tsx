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
} from "lucide-react";
import { PageHeader, Badge, Button, Select, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useInvoices, type Invoice, type InvoiceStatus } from "@/lib/api/invoices";

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

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<InvoiceStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  SENT: "bg-blue-100 text-blue-700",
  VIEWED: "bg-purple-100 text-purple-700",
  PARTIAL: "bg-yellow-100 text-yellow-700",
  PAID: "bg-green-100 text-green-700",
  VOID: "bg-red-100 text-red-600",
  OVERDUE: "bg-red-100 text-red-600",
  WRITTEN_OFF: "bg-stone-100 text-stone-600",
};

function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        STATUS_COLORS[status] ?? "bg-gray-100 text-gray-600",
      )}
    >
      {status === "WRITTEN_OFF"
        ? "Written Off"
        : status.charAt(0) + status.slice(1).toLowerCase()}
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
  { value: "SENT", label: "Sent" },
  { value: "VIEWED", label: "Viewed" },
  { value: "PARTIAL", label: "Partial" },
  { value: "PAID", label: "Paid" },
  { value: "VOID", label: "Void" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "WRITTEN_OFF", label: "Written Off" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Invoices"); }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const LIMIT = 20;

  const { data, isLoading, isError } = useInvoices({
    status: statusFilter || undefined,
    search: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit: LIMIT,
  });

  const invoices = data?.data ?? [];
  const meta = data?.meta;

  // Compute KPI counts from current full dataset (unfiltered request for summary)
  const { data: allData } = useInvoices({ limit: 999 });
  const all = allData?.data ?? [];

  const kpiCounts = React.useMemo(() => {
    const counts = { total: all.length, draft: 0, sent: 0, paid: 0, overdue: 0 };
    for (const inv of all) {
      if (inv.status === "DRAFT") counts.draft++;
      if (inv.status === "SENT" || inv.status === "VIEWED") counts.sent++;
      if (inv.status === "PAID") counts.paid++;
      if (inv.status === "OVERDUE") counts.overdue++;
    }
    return counts;
  }, [all]);

  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Invoices"
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => router.push("/invoices/recurring")}>
              Recurring
            </Button>
            <Button
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => router.push("/invoices/new")}
            >
              New Invoice
            </Button>
          </div>
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
          label="Sent"
          value={kpiCounts.sent}
          active={statusFilter === "SENT"}
          onClick={() => { setStatusFilter("SENT"); setPage(1); }}
        />
        <KpiChip
          label="Paid"
          value={kpiCounts.paid}
          active={statusFilter === "PAID"}
          onClick={() => { setStatusFilter("PAID"); setPage(1); }}
        />
        <KpiChip
          label="Overdue"
          value={kpiCounts.overdue}
          danger
          active={statusFilter === "OVERDUE"}
          onClick={() => { setStatusFilter("OVERDUE"); setPage(1); }}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by invoice # or customer…"
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
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Invoice #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Issue Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Due Date</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Total</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Balance</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Status</th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/40" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load invoices. Please try again.
                </td>
              </tr>
            ) : invoices.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <FileText className="h-8 w-8 text-navy/20" />
                    <p className="text-sm text-navy/40">No invoices match your filters.</p>
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
              invoices.map((inv: Invoice) => (
                <tr
                  key={inv.id}
                  onClick={() => router.push(`/invoices/${inv.id}`)}
                  className="cursor-pointer transition-colors hover:bg-surface-raised"
                >
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                    {inv.invoiceNumber}
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">
                    {inv.customer?.businessName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-navy/60">
                    {fmtDate((inv as any).issueDate ?? inv.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-navy/60">
                    {fmtDate(inv.dueDate)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-navy">
                    {fmt.format(Number(inv.total))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(() => {
                      const paid = (inv as any).payments?.reduce((s: number, p: any) => s + Number(p.amount), 0) ?? Number((inv as any).amountPaid ?? 0);
                      const balance = Math.max(0, Number(inv.total) - paid);
                      return (
                        <span className={cn("font-medium", balance > 0 ? "text-danger" : "text-navy/40")}>
                          {fmt.format(balance)}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3">
                    <InvoiceStatusBadge status={inv.status} />
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="View invoice"
                      onClick={() => router.push(`/invoices/${inv.id}`)}
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
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/50">
            Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total} invoices
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
