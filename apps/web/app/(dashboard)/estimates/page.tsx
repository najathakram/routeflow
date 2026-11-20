"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Eye, Calendar, X, Loader2, Search } from "lucide-react";
import { PageHeader, Button, Select, cn, EmptyState, Badge } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useClampPage } from "@/lib/hooks/useUrlPage";
import { useEstimates, type Estimate } from "@/lib/api/estimates";
import { fmt, fmtCalendarDate } from "@/lib/formatting";
import { ReadOnlyHint, WriteButton } from "@/lib/read-only-gate";
import { CreateEstimateModal } from "./EstimateFormModal";

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
              : "bg-surface-raised text-navy/70",
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
  { value: "ACCEPTED", label: "Accepted" },
  { value: "DECLINED", label: "Declined" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EstimatesPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Estimates");
  }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = useUrlPage();
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const LIMIT = 20;

  const { data, isLoading, isError } = useEstimates({
    status: statusFilter || undefined,
    search: debouncedSearch || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit: LIMIT,
  });

  const estimates = data?.data ?? [];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);

  const { data: allData } = useEstimates({ limit: 999 });
  const all = allData?.data ?? [];

  const kpiCounts = React.useMemo(() => {
    const counts = { total: all.length, draft: 0, sent: 0, accepted: 0, declined: 0 };
    for (const est of all) {
      if (est.status === "DRAFT") counts.draft++;
      if (est.status === "SENT") counts.sent++;
      if (est.status === "ACCEPTED") counts.accepted++;
      if (est.status === "DECLINED") counts.declined++;
    }
    return counts;
  }, [all]);

  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Estimates"
        action={
          <div className="flex flex-col items-end">
            <WriteButton
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setIsCreateOpen(true)}
            >
              New estimate
            </WriteButton>
            <ReadOnlyHint />
          </div>
        }
      />

      {/* KPI chips */}
      <div className="flex flex-wrap items-center gap-2">
        <KpiChip
          label="All"
          value={kpiCounts.total}
          active={statusFilter === ""}
          onClick={() => {
            setStatusFilter("");
            setPage(1);
          }}
        />
        <KpiChip
          label="Draft"
          value={kpiCounts.draft}
          active={statusFilter === "DRAFT"}
          onClick={() => {
            setStatusFilter("DRAFT");
            setPage(1);
          }}
        />
        <KpiChip
          label="Sent"
          value={kpiCounts.sent}
          active={statusFilter === "SENT"}
          onClick={() => {
            setStatusFilter("SENT");
            setPage(1);
          }}
        />
        <KpiChip
          label="Accepted"
          value={kpiCounts.accepted}
          active={statusFilter === "ACCEPTED"}
          onClick={() => {
            setStatusFilter("ACCEPTED");
            setPage(1);
          }}
        />
        <KpiChip
          label="Declined"
          value={kpiCounts.declined}
          danger
          active={statusFilter === "DECLINED"}
          onClick={() => {
            setStatusFilter("DECLINED");
            setPage(1);
          }}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by estimate # or customer…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-44">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {/* Date range */}
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/70" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
            className="h-10 w-32 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Issue date from"
          />
          <span className="text-navy/70">–</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
            className="h-10 w-32 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Issue date to"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => {
                setDateFrom("");
                setDateTo("");
                setPage(1);
              }}
              className="rounded p-1.5 text-navy/70 hover:text-danger transition-colors"
              title="Clear dates"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        {/* #2211: the bare table clipped at 320-430px; the inner wrapper scrolls it, the outer
            div keeps overflow-hidden only for its rounded corners (same pattern as B750). */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Estimate #</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Customer</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Issue date</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">
                  Expiry date
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Total</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Status</th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border bg-white">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-danger">
                    Failed to load estimates. Please try again.
                  </td>
                </tr>
              ) : estimates.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-0">
                    {search || statusFilter || dateFrom || dateTo ? (
                      <EmptyState
                        variant="invoices"
                        title="No matching estimates"
                        description="No estimates match your current search and filters."
                        action={
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setSearch("");
                              setStatusFilter("");
                              setDateFrom("");
                              setDateTo("");
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
                        title="No estimates yet"
                        description="Create an estimate to quote a customer before converting it to an invoice."
                        action={
                          <WriteButton size="sm" onClick={() => setIsCreateOpen(true)}>
                            New estimate
                          </WriteButton>
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : (
                estimates.map((est: Estimate) => (
                  <tr
                    key={est.id}
                    onClick={() => router.push(`/estimates/${est.id}`)}
                    className="cursor-pointer transition-colors hover:bg-surface-raised"
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                      {est.estimateNumber}
                    </td>
                    <td className="px-4 py-3 font-medium text-navy">
                      {est.customer?.businessName ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-navy">
                      {fmtCalendarDate(est.issueDate ?? est.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-navy">
                      {fmtCalendarDate((est as any).expiresAt ?? (est as any).expiryDate)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-navy">
                      {fmt(Number(est.total))}
                    </td>
                    <td className="px-4 py-3">
                      <Badge status={est.status} />
                    </td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        title="View estimate"
                        onClick={() => router.push(`/estimates/${est.id}`)}
                        className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
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
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total}{" "}
            estimates
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

      {/* Create modal */}
      <CreateEstimateModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(id) => router.push(`/estimates/${id}`)}
      />
    </div>
  );
}
