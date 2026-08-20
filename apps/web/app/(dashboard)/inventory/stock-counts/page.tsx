"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge, type BadgeVariant, Button, PageHeader } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { fmt, fmtDate } from "@/lib/formatting";
import { useUrlPage, useClampPage } from "@/lib/hooks/useUrlPage";
import { useStockCountSessions, type StockCountStatus } from "@/lib/api/stock-count";

const STATUS_META: Record<StockCountStatus, { variant: BadgeVariant; label: string }> = {
  OPEN: { variant: "info", label: "Open" },
  REVIEW: { variant: "warning", label: "In review" },
  COMMITTED: { variant: "success", label: "Committed" },
  DISCARDED: { variant: "neutral", label: "Discarded" },
};

const STATUS_CHIPS: { value: StockCountStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "OPEN", label: "Open" },
  { value: "REVIEW", label: "In review" },
  { value: "COMMITTED", label: "Committed" },
  { value: "DISCARDED", label: "Discarded" },
];

export default function StockCountsHistoryPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Stock Counts");
  }, [setTitle]);

  const [status, setStatus] = React.useState<StockCountStatus | "">("");
  const [page, setPage] = useUrlPage();

  const { data, isLoading } = useStockCountSessions({
    status: status || undefined,
    page,
    limit: 20,
  });
  const sessions = data?.data ?? [];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);

  return (
    <div className="space-y-5 p-6">
      <Link
        href="/inventory"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Inventory
      </Link>

      <PageHeader
        title="Stock Counts"
        subtitle="History of every stock-count session — who counted what, and what it changed."
      />

      <div className="flex flex-wrap gap-2">
        {STATUS_CHIPS.map((chip) => (
          <button
            key={chip.value || "all"}
            type="button"
            onClick={() => {
              setStatus(chip.value);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              status === chip.value
                ? "border-brand-500 bg-brand-50 text-brand-700"
                : "border-surface-border text-navy/70 hover:bg-surface-raised"
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-navy/70">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-surface-border">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
              <tr>
                {["Status", "Date", "Name", "Started by", "# Lines", "Net variance", ""].map(
                  (h) => (
                    <th key={h} className="px-4 py-3 text-left font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {sessions.map((s) => {
                const net = s.netVarianceMoney;
                return (
                  <tr key={s.id} className="transition-colors hover:bg-surface-raised/50">
                    <td className="px-4 py-3">
                      <Badge
                        variant={STATUS_META[s.status].variant}
                        label={STATUS_META[s.status].label}
                      />
                    </td>
                    <td className="px-4 py-3 text-navy/70 whitespace-nowrap">
                      {fmtDate(s.startedAt)}
                    </td>
                    <td className="px-4 py-3 font-medium text-navy">
                      {s.name || "Untitled count"}
                    </td>
                    <td className="px-4 py-3 text-navy/70">{s.startedBy?.username ?? "—"}</td>
                    <td className="px-4 py-3 text-navy/70">{s._count?.lines ?? 0}</td>
                    <td
                      className={`px-4 py-3 font-mono font-medium ${
                        net > 0 ? "text-success" : net < 0 ? "text-danger" : "text-navy/70"
                      }`}
                    >
                      {net > 0 ? "+" : net < 0 ? "−" : ""}
                      {fmt(Math.abs(net))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/inventory/stock-counts/${s.id}`}
                        className="text-brand-600 hover:text-brand-700 hover:underline"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-navy/70">
                    No stock counts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            Page {meta.page} of {meta.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page >= meta.totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
