"use client";

import * as React from "react";
import { ChevronDown, Loader2, Plus, Search } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { useEligibleTripOrders, type EligibleTripOrderRow } from "@/lib/api/trips";
import { fmt, fmtCalendarDate } from "@/lib/formatting";

const PAGE_SIZE = 20;

export interface OrderPickerPanelProps {
  /** Order ids already selected in the builder — dropped server-side via `exclude`. */
  excludeIds: string[];
  onAdd: (orderId: string) => void;
  /** Initial open/closed state — read once at mount, not resynced on later prop changes. */
  defaultOpen?: boolean;
  /** Optional note shown under the header (e.g. the direct-nav empty-state hint). */
  hint?: string;
  className?: string;
}

/**
 * Collapsible "Add orders" section for the trip builder (PICKING phase only).
 * Backed by GET /trips/eligible-orders (WP-E1's TripsService.getEligibleOrders) —
 * every row is already addable (server-side checkEligibility ran, `eligible` is
 * always true), so this never re-implements the eligibility/skip logic the
 * Stops and Skipped panels already own for orders that ARE in the builder.
 */
export function OrderPickerPanel({
  excludeIds,
  onAdd,
  defaultOpen = false,
  hint,
  className,
}: OrderPickerPanelProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [rows, setRows] = React.useState<EligibleTripOrderRow[]>([]);

  const excludeKey = excludeIds.join(",");

  // Debounce the typed search so we don't fire a request per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A new search term or a changed exclusion set (an order was added/removed
  // elsewhere in the builder) invalidates the accumulated "Load more" pages —
  // restart from page 1 so we never show a stale mix of pages.
  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, excludeKey]);

  // Only fetch while expanded — the panel can sit collapsed for the whole
  // PICKING phase, and shouldn't poll the endpoint until the operator opens it.
  const { data, isFetching, isError, refetch } = useEligibleTripOrders(
    { search: debouncedSearch || undefined, page, limit: PAGE_SIZE, exclude: excludeIds },
    { enabled: open },
  );

  // Replace on page 1 (fresh search/exclude set), append for "Load more".
  // With placeholderData: keepPreviousData, `data` can still hold the PREVIOUS
  // page's response for a render or two after `page` changes — accumulating
  // that stale page here would duplicate rows/keys (and, when the exclude-key
  // effect above resets page to 1, transiently replace with the wrong page).
  // Wait for `data` to actually match the current `page` before touching rows.
  React.useEffect(() => {
    if (!data || data.meta.page !== page) return;
    setRows((prev) => (page === 1 ? data.data : [...prev, ...data.data]));
  }, [data, page]);

  // A post-eligibility safety filter runs server-side after the SQL `where`,
  // so a page can come back shorter than `limit` — or even empty — while
  // meta.total/totalPages still count the pre-filter superset. Stop offering
  // "Load more" on an empty page rather than trusting totalPages alone, or a
  // sparse tail of eligible orders could read as a stuck/broken button.
  const hasMore = !!data && data.data.length > 0 && data.meta.page < data.meta.totalPages;

  return (
    <div className={cn("rounded-lg border border-surface-border bg-white", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2"
        aria-expanded={open}
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-navy/70">
          Add orders
        </span>
        <ChevronDown
          className={cn("h-4 w-4 text-navy/50 transition-transform", open && "rotate-180")}
        />
      </button>

      {hint && (
        <p className="border-t border-surface-border bg-surface-raised px-3 py-2 text-[11px] text-navy/70">
          {hint}
        </p>
      )}

      {open && (
        <div className="border-t border-surface-border p-3">
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-surface-border bg-white px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-navy/70" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search order # or customer…"
              className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/30 focus:outline-none"
            />
          </div>

          {isError ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2">
              <span className="text-xs text-danger">Failed to load orders.</span>
              <button
                type="button"
                onClick={() => refetch()}
                className="text-xs font-medium text-danger underline"
              >
                Retry
              </button>
            </div>
          ) : rows.length === 0 ? (
            isFetching ? (
              <div className="h-16 animate-pulse rounded-lg bg-surface-raised" />
            ) : (
              <p className="px-1 py-3 text-xs text-navy/70">
                {debouncedSearch.trim() ? "No matching orders." : "No eligible orders to add."}
              </p>
            )
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {rows.map((row) => (
                <li
                  key={row.orderId}
                  className="flex items-center justify-between gap-2 rounded-lg border border-surface-border px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-navy">
                      #{row.orderNumber ?? row.orderId.slice(0, 8).toUpperCase()} ·{" "}
                      {row.customerName ?? "Unknown customer"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-navy/70">
                      {fmt(row.total)} · {row.itemCount} item{row.itemCount !== 1 ? "s" : ""} ·{" "}
                      {fmtCalendarDate(row.deliveryDate)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onAdd(row.orderId)}
                    className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-brand-600 transition-colors hover:bg-brand-50"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </li>
              ))}
            </ul>
          )}

          {hasMore && (
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={isFetching}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-surface-border py-1.5 text-xs font-medium text-navy/70 transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
