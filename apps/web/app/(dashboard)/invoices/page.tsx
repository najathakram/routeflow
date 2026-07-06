"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Eye,
  Calendar,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Trash2,
  Download,
} from "lucide-react";
import { PageHeader, Button, cn, useToast, EmptyState } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useDebounce } from "@/lib/hooks/useDebounce";
import { useUrlFilters } from "@/lib/hooks/useUrlFilters";
import { downloadCsv, csvDate } from "@/lib/export";
import {
  useInvoices,
  useDeleteInvoice,
  type Invoice,
  type InvoiceStatus,
} from "@/lib/api/invoices";
import { apiClient } from "@/lib/api-client";
import { useBookkeepingSummary } from "@/lib/api/bookkeeping";
import { fmt, fmtDate } from "@/lib/formatting";
import { useAuth } from "@/lib/auth-context";

// ─── Contextual status display (Zoho-style) ───────────────────────────────────

function renderStatus(status: InvoiceStatus, dueDate?: string | null): React.ReactNode {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (status === "PAID") {
    return <span className="text-xs font-semibold text-success">Paid</span>;
  }
  if (status === "VOID") {
    return <span className="text-xs font-semibold text-navy/40">Void</span>;
  }
  if (status === "WRITTEN_OFF") {
    return <span className="text-xs font-semibold text-navy/50">Written Off</span>;
  }
  if (status === "DRAFT") {
    return <span className="text-xs font-semibold text-navy/50">Draft</span>;
  }
  if (status === "SENT") {
    return <span className="text-xs font-semibold text-brand-600">Sent</span>;
  }
  if (status === "VIEWED") {
    return <span className="text-xs font-semibold text-brand-700">Viewed</span>;
  }

  // For PARTIAL / OVERDUE — compute days to add context
  if (dueDate) {
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);
    const diffMs = due.getTime() - today.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (status === "OVERDUE" || diffDays < 0) {
      const overdueDays = Math.abs(diffDays);
      if (status === "PARTIAL") {
        return (
          <span className="text-xs font-semibold text-danger">
            Partial · Overdue{overdueDays > 0 ? ` by ${overdueDays}d` : ""}
          </span>
        );
      }
      return (
        <span className="text-xs font-semibold text-danger">
          Overdue{overdueDays > 0 ? ` by ${overdueDays} day${overdueDays !== 1 ? "s" : ""}` : ""}
        </span>
      );
    }

    if (diffDays === 0) {
      if (status === "PARTIAL") {
        return <span className="text-xs font-semibold text-warning">Partial · Due Today</span>;
      }
      return <span className="text-xs font-semibold text-warning">Due Today</span>;
    }

    if (status === "PARTIAL") {
      return (
        <span className="text-xs font-semibold text-warning">Partial · Due in {diffDays}d</span>
      );
    }

    return (
      <span className="text-xs font-semibold text-brand-600">
        Due in {diffDays} day{diffDays !== 1 ? "s" : ""}
      </span>
    );
  }

  // No dueDate fallback
  const labels: Record<string, string> = {
    SENT: "Sent",
    VIEWED: "Viewed",
    PARTIAL: "Partial",
    OVERDUE: "Overdue",
  };
  const colors: Record<string, string> = {
    SENT: "text-brand-600",
    VIEWED: "text-brand-700",
    PARTIAL: "text-warning",
    OVERDUE: "text-danger",
  };
  return (
    <span className={cn("text-xs font-semibold", colors[status] ?? "text-navy/50")}>
      {labels[status] ?? status}
    </span>
  );
}

// ─── Stat tile (Ledger idiom: overline · value · hint) ─────────────────────────

function StatTile({
  label,
  value,
  hint,
  money,
  valueClass,
  active,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  money?: boolean;
  valueClass?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="overline block">{label}</span>
      <span
        className={cn(
          "mt-1.5 block text-2xl text-navy",
          money ? "money" : "font-semibold tracking-[-0.02em]",
          valueClass,
        )}
      >
        {value}
      </span>
      {hint && <span className="mt-1 block text-xs text-navy/70">{hint}</span>}
    </>
  );

  const base = "rounded-lg border bg-white p-4 text-left shadow-card";

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          base,
          "transition-all hover:bg-surface-raised",
          active ? "border-brand-200 ring-1 ring-inset ring-brand-200" : "border-surface-border",
        )}
      >
        {content}
      </button>
    );
  }

  return <div className={cn(base, "border-surface-border")}>{content}</div>;
}

// ─── Payment Summary (KPI stat tiles) ─────────────────────────────────────────

function PaymentSummaryBar({
  activeFilter,
  onFilter,
}: {
  activeFilter: string;
  onFilter: (status: string) => void;
}) {
  const { data: allData } = useInvoices({ limit: 999 });
  const all: Invoice[] = allData?.data ?? [];

  const kpis = React.useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const in30 = new Date(today);
    in30.setDate(in30.getDate() + 30);

    let totalOutstanding = 0;
    let dueToday = 0;
    let dueIn30 = 0;
    let overdue = 0;
    let paidInvoiceCount = 0;
    let totalDaysToPay = 0;

    for (const inv of all) {
      const total = Number(inv.total);
      const paid =
        inv.paidAmount ??
        (inv.payments ?? []).reduce((s: number, p: any) => s + Number(p.amount), 0);
      const balance =
        inv.balanceDue !== undefined ? Number(inv.balanceDue) : Math.max(0, total - paid);
      const due = inv.dueDate ? new Date(inv.dueDate) : null;
      if (due) due.setHours(0, 0, 0, 0);

      if (
        inv.status !== "PAID" &&
        inv.status !== "VOID" &&
        inv.status !== "WRITTEN_OFF" &&
        inv.status !== "DRAFT"
      ) {
        totalOutstanding += balance;
      }

      if (
        inv.status === "OVERDUE" ||
        (due && due < today && inv.status !== "PAID" && inv.status !== "VOID")
      ) {
        overdue += balance;
      } else if (due && due.getTime() === today.getTime() && inv.status !== "PAID") {
        dueToday += balance;
      } else if (
        due &&
        due <= in30 &&
        due > today &&
        inv.status !== "PAID" &&
        inv.status !== "VOID"
      ) {
        dueIn30 += balance;
      }

      if (inv.status === "PAID" && inv.sentAt && inv.paidAt) {
        const sent = new Date(inv.sentAt);
        const paidAt = new Date(inv.paidAt);
        const days = Math.round((paidAt.getTime() - sent.getTime()) / (1000 * 60 * 60 * 24));
        if (days >= 0) {
          totalDaysToPay += days;
          paidInvoiceCount++;
        }
      }
    }

    const avgDays = paidInvoiceCount > 0 ? Math.round(totalDaysToPay / paidInvoiceCount) : 0;

    return { totalOutstanding, dueToday, dueIn30, overdue, avgDays };
  }, [all]);

  const items = [
    {
      label: "Total Outstanding",
      value: fmt(kpis.totalOutstanding),
      filter: "SENT",
      money: true,
      valueClass: undefined as string | undefined,
    },
    {
      label: "Due Today",
      value: fmt(kpis.dueToday),
      filter: "",
      money: true,
      valueClass: kpis.dueToday > 0 ? "text-orange-500" : undefined,
    },
    {
      label: "Due Within 30 Days",
      value: fmt(kpis.dueIn30),
      filter: "",
      money: true,
      valueClass: undefined as string | undefined,
    },
    {
      label: "Overdue",
      value: fmt(kpis.overdue),
      filter: "OVERDUE",
      money: true,
      valueClass: kpis.overdue > 0 ? "text-red-600" : undefined,
    },
    {
      label: "Avg. Days to Get Paid",
      value: kpis.avgDays > 0 ? `${kpis.avgDays} Days` : "N/A",
      filter: "PAID",
      money: false,
      valueClass: undefined as string | undefined,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((item) => (
        <StatTile
          key={item.label}
          label={item.label}
          value={item.value}
          money={item.money}
          valueClass={item.valueClass}
          active={!!item.filter && item.filter === activeFilter}
          onClick={
            item.filter
              ? () => onFilter(item.filter === activeFilter ? "" : item.filter)
              : undefined
          }
        />
      ))}
    </div>
  );
}

// ─── Status filter tabs ────────────────────────────────────────────────────────

const STATUS_TABS = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "SENT", label: "Sent" },
  { value: "VIEWED", label: "Viewed" },
  { value: "PARTIAL", label: "Partial" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "PAID", label: "Paid" },
  { value: "VOID", label: "Void" },
  { value: "WRITTEN_OFF", label: "Written Off" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const router = useRouter();

  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const isCustomer = user?.role === "CUSTOMER";
  React.useEffect(() => {
    setTitle("Invoices");
  }, [setTitle]);

  const { toast } = useToast();
  const deleteInvoice = useDeleteInvoice();
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);

  const [urlFilters, setFilter] = useUrlFilters({ status: "", dateFrom: "", dateTo: "" });
  const statusFilter = (urlFilters.status as string) ?? "";
  const dateFrom = (urlFilters.dateFrom as string) ?? "";
  const dateTo = (urlFilters.dateTo as string) ?? "";
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = React.useState(1);
  const [limit, setLimit] = React.useState(20);
  const [sortBy, setSortBy] = React.useState("issueDate");
  const [sortOrder, setSortOrder] = React.useState<"asc" | "desc">("desc");

  const toggleSort = (col: string) => {
    if (sortBy === col) setSortOrder((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortOrder("asc");
    }
    setPage(1);
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortBy !== col) return <ChevronsUpDown className="h-3 w-3 ml-0.5 text-current/40 inline" />;
    return sortOrder === "asc" ? (
      <ChevronUp className="h-3 w-3 ml-0.5 inline" />
    ) : (
      <ChevronDown className="h-3 w-3 ml-0.5 inline" />
    );
  };

  const { data, isLoading, isError } = useInvoices({
    status: statusFilter || undefined,
    search: debouncedSearch || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    sortBy,
    sortOrder,
    page,
    limit,
  });

  const invoices = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  const [isExporting, setIsExporting] = React.useState(false);

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const EXPORT_LIMIT = 1000;
      const res = await apiClient.get("/invoices", {
        params: {
          status: statusFilter || undefined,
          search: debouncedSearch || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          sortBy,
          sortOrder,
          page: 1,
          limit: EXPORT_LIMIT,
        },
      });
      const payload = res.data as { data: Invoice[]; meta?: { total?: number } };
      const rows = payload.data ?? [];
      downloadCsv(
        `invoices-${new Date().toISOString().split("T")[0]}.csv`,
        ["Invoice #", "Customer", "Issue Date", "Due Date", "Total", "Balance Due", "Status"],
        rows.map((inv) => [
          inv.invoiceNumber,
          inv.customer?.businessName ?? "",
          csvDate(inv.issueDate),
          csvDate(inv.dueDate),
          Number(inv.total ?? 0).toFixed(2),
          Number(inv.balanceDue ?? 0).toFixed(2),
          inv.status,
        ]),
      );
      const total = payload.meta?.total ?? rows.length;
      if (total > EXPORT_LIMIT) {
        toast({
          title: `Exported first ${EXPORT_LIMIT} rows`,
          description: `Narrow filters to export the remaining ${total - EXPORT_LIMIT}.`,
          variant: "warning",
        });
      }
    } catch (err) {
      toast({ title: "Export failed", description: (err as Error).message, variant: "error" });
    } finally {
      setIsExporting(false);
    }
  };

  function handleFilterChange(status: string) {
    setFilter("status", status);
    setPage(1);
  }

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Invoices"
        subtitle="Track receivables — what's outstanding, due soon, and overdue across your customers."
        action={
          !isCustomer ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={
                  isExporting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )
                }
                onClick={handleExport}
                disabled={isExporting}
                title="Export filtered invoices as CSV"
              >
                {isExporting ? "Exporting…" : "Export"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push("/invoices/payments")}
              >
                Payments Received
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push("/invoices/recurring")}
              >
                Recurring
              </Button>
              <Button
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => router.push("/invoices/new")}
              >
                New Invoice
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* Payment Summary — KPI stat tiles */}
      <PaymentSummaryBar activeFilter={statusFilter} onFilter={handleFilterChange} />

      {/* Status filter tabs */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide border-b border-surface-border">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => handleFilterChange(tab.value)}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              statusFilter === tab.value
                ? "border-brand-500 text-brand-500"
                : "border-transparent text-navy/70 hover:text-navy",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Search by invoice # or customer…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="h-9 w-56 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/70" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setFilter("dateFrom", e.target.value);
              setPage(1);
            }}
            max={dateTo || undefined}
            className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Issue date from"
          />
          <span className="text-navy/70">–</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => {
              setFilter("dateTo", e.target.value);
              setPage(1);
            }}
            className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Issue date to"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => {
                setFilter("dateFrom", "");
                setFilter("dateTo", "");
                setPage(1);
              }}
              className="rounded p-1 text-navy/70 hover:text-danger transition-colors"
              title="Clear dates"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-gray-50">
            <tr>
              <th
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("issueDate")}
              >
                Date <SortIcon col="issueDate" />
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("invoiceNumber")}
              >
                Invoice # <SortIcon col="invoiceNumber" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                Customer Name
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("status")}
              >
                Status <SortIcon col="status" />
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("dueDate")}
              >
                Due Date <SortIcon col="dueDate" />
              </th>
              <th
                className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("total")}
              >
                Amount <SortIcon col="total" />
              </th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                Balance Due
              </th>
              <th className="w-20 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
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
                <td colSpan={8} className="p-0">
                  {search || statusFilter || dateFrom || dateTo ? (
                    <EmptyState
                      variant="invoices"
                      title="No matching invoices"
                      description="No invoices match your current search and filters."
                      action={
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setSearch("");
                            setFilter("status", "");
                            setFilter("dateFrom", "");
                            setFilter("dateTo", "");
                            setPage(1);
                          }}
                        >
                          Clear filters
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      variant="invoices"
                      title="No invoices yet"
                      description="Create an invoice to bill a customer and start tracking receivables."
                      action={
                        <Button size="sm" onClick={() => router.push("/invoices/new")}>
                          New Invoice
                        </Button>
                      }
                    />
                  )}
                </td>
              </tr>
            ) : (
              invoices.map((inv: Invoice) => {
                const paid =
                  inv.paidAmount ??
                  (inv.payments ?? []).reduce((s: number, p: any) => s + Number(p.amount), 0);
                const balance =
                  inv.balanceDue !== undefined
                    ? Number(inv.balanceDue)
                    : Math.max(0, Number(inv.total) - paid);
                return (
                  <tr
                    key={inv.id}
                    onClick={() => router.push(`/invoices/${inv.id}`)}
                    className="group cursor-pointer transition-colors hover:bg-blue-50/40"
                  >
                    <td className="px-4 py-3 text-sm text-navy">
                      {fmtDate((inv as any).issueDate ?? inv.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-xs font-semibold text-brand-500">
                          {inv.invoiceNumber}
                        </span>
                        <span
                          className={cn(
                            "inline-flex w-fit items-center rounded-full px-1.5 py-px text-[10px] font-medium leading-tight",
                            (inv as any).orderId
                              ? "bg-brand-50 text-brand-600"
                              : "bg-surface-raised text-navy/70",
                          )}
                        >
                          {(inv as any).orderId ? "From Order" : "Manual"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-medium text-navy">
                      {inv.customer?.businessName ?? "—"}
                    </td>
                    <td className="px-4 py-3">{renderStatus(inv.status, inv.dueDate)}</td>
                    <td className="px-4 py-3 text-sm text-navy">{fmtDate(inv.dueDate)}</td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-navy">
                      {fmt(Number(inv.total))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={cn(
                          "text-sm font-semibold",
                          balance > 0 ? "text-danger" : "text-navy",
                        )}
                      >
                        {fmt(balance)}
                      </span>
                    </td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      {!isCustomer && confirmDeleteId === inv.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            title="Confirm delete"
                            disabled={deleteInvoice.isPending}
                            onClick={async () => {
                              try {
                                await deleteInvoice.mutateAsync(inv.id);
                                setConfirmDeleteId(null);
                                toast({ title: "Invoice deleted", variant: "success" });
                              } catch (err: any) {
                                setConfirmDeleteId(null);
                                toast({
                                  title: "Delete failed",
                                  description:
                                    err?.response?.data?.message ?? err?.message ?? "Unknown error",
                                  variant: "error",
                                });
                              }
                            }}
                            className="rounded px-2 py-1 text-xs font-semibold text-white bg-danger hover:bg-danger/80 disabled:opacity-50 transition-colors"
                          >
                            {deleteInvoice.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Delete"
                            )}
                          </button>
                          <button
                            title="Cancel"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded p-1 text-navy/70 hover:text-navy transition-colors"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5">
                          <button
                            title="View invoice"
                            onClick={() => router.push(`/invoices/${inv.id}`)}
                            className="rounded p-1.5 text-navy/70 hover:bg-white hover:text-navy transition-colors"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          {!isCustomer && (
                            <button
                              title="Delete invoice"
                              onClick={() => setConfirmDeleteId(inv.id)}
                              className="rounded p-1.5 text-navy/70 hover:bg-white hover:text-danger transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {meta && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <p className="text-sm text-navy/70">
              {meta.total > 0
                ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total} invoices`
                : "No invoices found"}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-navy/70">Per page:</span>
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
                className="h-8 rounded border border-surface-border bg-white px-2 text-xs text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
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
    </div>
  );
}
