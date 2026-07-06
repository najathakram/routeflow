"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Eye,
  Loader2,
  Calendar,
  X,
  CheckSquare,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Download,
} from "lucide-react";
import { PageHeader, Badge, Select, Button, cn, useToast, EmptyState } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useOrders, useUpdateOrderStatus, useBulkDeleteOrders, type Order } from "@/lib/api/orders";
import { useUrlFilters } from "@/lib/hooks/useUrlFilters";
import { downloadCsv, csvDate } from "@/lib/export";
import { apiClient } from "@/lib/api-client";
import { CreateOrderModal } from "./_components/CreateOrderModal";

// ─── Saved view definitions ───────────────────────────────────────────────────

const SAVED_VIEWS = [
  { id: "all", label: "All", filters: {} as Record<string, string | boolean> },
  { id: "pending", label: "Pending", filters: { status: "PENDING" } },
  { id: "confirmed", label: "Confirmed", filters: { status: "CONFIRMED" } },
  { id: "delivery", label: "Out for Delivery", filters: { status: "OUT_FOR_DELIVERY" } },
  { id: "urgent", label: "Urgent", filters: { urgent: true } },
  { id: "delivered", label: "Delivered", filters: { status: "DELIVERED" } },
  { id: "cancelled", label: "Cancelled", filters: { status: "CANCELLED" } },
];

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING", label: "Pending" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { value: "PARTIALLY_DELIVERED", label: "Partially Delivered" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "CANCELLED", label: "Cancelled" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Orders");
  }, [setTitle]);

  // URL-backed filter state
  const [urlFilters, setFilter, clearFilters] = useUrlFilters({
    status: "",
    urgent: false,
    dateFrom: "",
    dateTo: "",
  });
  const statusFilter = (urlFilters.status as string) ?? "";
  const urgentOnly = (urlFilters.urgent as boolean) ?? false;
  const dateFrom = (urlFilters.dateFrom as string) ?? "";
  const dateTo = (urlFilters.dateTo as string) ?? "";

  // Customer search stays local (too transient for URL)
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  // Draft resume state (pos-cost-roles-spec §2): which parked draft to hydrate and
  // an optional barcode to add on open.
  const [resumeDraftId, setResumeDraftId] = React.useState<string | null>(null);
  const [initialScanCode, setInitialScanCode] = React.useState<string | null>(null);

  // Open the builder from URL intents: ?action=new (fresh), ?resumeDraft=<id>
  // (resume a parked draft), optional &scan=<code> (add on open). Runs on mount and
  // whenever the params change — so Resume from the draft dock works even when
  // already on this page — then strips the params so a refresh won't reopen it.
  React.useEffect(() => {
    const action = searchParams.get("action");
    const resume = searchParams.get("resumeDraft");
    const scan = searchParams.get("scan");
    if (resume) {
      setResumeDraftId(resume);
      setInitialScanCode(scan);
      setIsCreateOpen(true);
      router.replace("/orders");
    } else if (action === "new") {
      setResumeDraftId(null);
      setInitialScanCode(scan);
      setIsCreateOpen(true);
      router.replace("/orders");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [isCancelling, setIsCancelling] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [limit, setLimit] = React.useState(20);
  const [sortCol, setSortCol] = React.useState<string>("createdAt");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortCol !== col) return <ChevronsUpDown className="h-3 w-3 ml-0.5 text-navy/30 inline" />;
    return sortDir === "asc" ? (
      <ChevronUp className="h-3 w-3 ml-0.5 inline" />
    ) : (
      <ChevronDown className="h-3 w-3 ml-0.5 inline" />
    );
  };
  const { toast } = useToast();
  const updateStatus = useUpdateOrderStatus();
  const bulkDelete = useBulkDeleteOrders();

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
    setDeleteConfirm(false);
  };

  const handleBulkCancel = async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      await Promise.all(
        Array.from(selected).map((id) => updateStatus.mutateAsync({ id, status: "CANCELLED" })),
      );
      toast({
        title: `${selected.size} order${selected.size !== 1 ? "s" : ""} cancelled`,
        variant: "success",
      });
      exitSelectMode();
    } catch {
      toast({ title: "Failed to cancel some orders", variant: "error" });
    } finally {
      setIsCancelling(false);
    }
  };

  const handleBulkDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      const result = await bulkDelete.mutateAsync(Array.from(selected));
      if (result.errors.length > 0) {
        toast({
          title: `${result.deleted} deleted, ${result.errors.length} failed (only PENDING/CANCELLED orders can be deleted)`,
          variant: "error",
        });
      } else {
        toast({
          title: `${result.deleted} order${result.deleted !== 1 ? "s" : ""} deleted`,
          variant: "success",
        });
      }
      exitSelectMode();
    } catch {
      toast({ title: "Failed to delete orders", variant: "error" });
    } finally {
      setIsDeleting(false);
      setDeleteConfirm(false);
    }
  };

  // Reset page when filters change (page state stays local)
  React.useEffect(() => {
    setPage(1);
  }, [statusFilter, urgentOnly, dateFrom, dateTo]);

  // Active saved view detection
  const activeSavedView = React.useMemo(() => {
    return (
      SAVED_VIEWS.find((v) => {
        const keys = Object.keys(v.filters);
        if (keys.length === 0) {
          return !statusFilter && !urgentOnly && !dateFrom && !dateTo;
        }
        return keys.every(
          (k) =>
            String((urlFilters as Record<string, unknown>)[k]) ===
            String((v.filters as Record<string, unknown>)[k]),
        );
      })?.id ?? null
    );
  }, [urlFilters, statusFilter, urgentOnly, dateFrom, dateTo]);

  const applyView = (view: (typeof SAVED_VIEWS)[0]) => {
    clearFilters();
    for (const [k, val] of Object.entries(view.filters)) {
      setFilter(k as never, val as string | boolean);
    }
  };

  const { data, isLoading, isError } = useOrders({
    status: statusFilter || undefined,
    urgent: urgentOnly || undefined,
    deliveryDateFrom: dateFrom || undefined,
    deliveryDateTo: dateTo || undefined,
    page,
    limit,
  });

  const orders = data?.data ?? [];
  const meta = data?.meta;

  const filtered = React.useMemo(() => {
    const q = customerSearch.toLowerCase();
    const list = orders.filter((o) => {
      if (
        q &&
        !o.customer?.businessName?.toLowerCase().includes(q) &&
        !o.orderNumber?.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
    return [...list].sort((a, b) => {
      // Urgent always floats to top regardless of sort column
      if (a.urgent && !b.urgent) return -1;
      if (!a.urgent && b.urgent) return 1;
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortCol === "orderNumber")
        return dir * (a.orderNumber ?? "").localeCompare(b.orderNumber ?? "");
      if (sortCol === "customer")
        return dir * (a.customer?.businessName ?? "").localeCompare(b.customer?.businessName ?? "");
      if (sortCol === "total") return dir * (Number(a.total) - Number(b.total));
      if (sortCol === "status") return dir * (a.status ?? "").localeCompare(b.status ?? "");
      if (sortCol === "deliveryDate")
        return dir * (a.requestedDeliveryDate ?? "").localeCompare(b.requestedDeliveryDate ?? "");
      // default: createdAt
      return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
  }, [orders, customerSearch, sortCol, sortDir]);

  const urgentCount = orders.filter((o) => o.urgent).length;

  const [isExporting, setIsExporting] = React.useState(false);

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const EXPORT_LIMIT = 1000;
      const res = await apiClient.get("/orders", {
        params: {
          status: statusFilter || undefined,
          urgent: urgentOnly || undefined,
          deliveryDateFrom: dateFrom || undefined,
          deliveryDateTo: dateTo || undefined,
          page: 1,
          limit: EXPORT_LIMIT,
        },
      });
      const payload = res.data as { data: Order[]; meta?: { total?: number } };
      const allOrders = payload.data ?? [];
      const q = customerSearch.toLowerCase();
      const rows = allOrders.filter((o) => {
        if (
          q &&
          !o.customer?.businessName?.toLowerCase().includes(q) &&
          !o.orderNumber?.toLowerCase().includes(q)
        )
          return false;
        return true;
      });
      downloadCsv(
        `orders-${new Date().toISOString().split("T")[0]}.csv`,
        ["Order #", "Customer", "Items", "Total", "Status", "Delivery Date", "Created"],
        rows.map((o) => [
          o.orderNumber ?? o.id.slice(0, 8).toUpperCase(),
          o.customer?.businessName ?? "",
          o.lineItems?.length ?? 0,
          Number(o.total ?? 0).toFixed(2),
          o.status,
          csvDate(o.requestedDeliveryDate),
          csvDate(o.createdAt),
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

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Orders"
        action={
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
              title="Export filtered orders as CSV"
            >
              {isExporting ? "Exporting…" : "Export"}
            </Button>
            <Button
              variant="secondary"
              leftIcon={
                selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />
              }
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            <Button onClick={() => setIsCreateOpen(true)}>New Order</Button>
          </div>
        }
      />

      {/* Selection action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-warning/30 bg-warning-bg px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selected.size} order{selected.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-navy/70 hover:text-navy transition-colors"
            >
              Deselect all
            </button>
            <Button
              variant="secondary"
              leftIcon={<X className="h-4 w-4" />}
              loading={isCancelling}
              onClick={handleBulkCancel}
            >
              Cancel {selected.size}
            </Button>
            {deleteConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-danger font-medium">
                  Delete {selected.size} orders?
                </span>
                <Button variant="danger" size="sm" loading={isDeleting} onClick={handleBulkDelete}>
                  Confirm Delete
                </Button>
                <button
                  onClick={() => setDeleteConfirm(false)}
                  className="text-sm text-navy/70 hover:text-navy transition-colors"
                >
                  No
                </button>
              </div>
            ) : (
              <Button
                variant="danger"
                leftIcon={<Trash2 className="h-4 w-4" />}
                onClick={() => setDeleteConfirm(true)}
              >
                Delete {selected.size}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Saved view chips */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {SAVED_VIEWS.map((view) => (
          <button
            key={view.id}
            onClick={() => applyView(view)}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              activeSavedView === view.id
                ? "bg-brand-600 text-white"
                : "bg-surface-raised text-navy/70 hover:bg-brand-50 hover:text-brand-700",
            )}
          >
            {view.label}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        {selectMode && filtered.length > 0 && (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filtered.every((o) => selected.has(o.id))}
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    filtered.some((o) => selected.has(o.id)) &&
                    !filtered.every((o) => selected.has(o.id));
              }}
              onChange={() => {
                if (filtered.every((o) => selected.has(o.id))) setSelected(new Set());
                else setSelected(new Set(filtered.map((o) => o.id)));
              }}
              className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
            />
            <span className="text-sm text-navy/70">Select all</span>
          </label>
        )}
        <input
          type="search"
          placeholder="Search by customer or order #…"
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-48">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => setFilter("status", e.target.value)}
          />
        </div>
        {/* Urgent toggle */}
        <button
          onClick={() => setFilter("urgent", !urgentOnly)}
          className={cn(
            "flex h-10 items-center gap-2 rounded border px-3 text-sm font-medium transition-colors",
            urgentOnly
              ? "border-danger/40 bg-danger-bg text-danger"
              : "border-surface-border bg-white text-navy/70 hover:text-navy",
          )}
        >
          <AlertTriangle className="h-4 w-4" />
          Urgent only
          {urgentOnly && urgentCount > 0 && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-white">
              {urgentCount}
            </span>
          )}
        </button>

        {/* Delivery date range filter */}
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/70" />
          <span className="text-xs text-navy/70 font-medium">Delivery:</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setFilter("dateFrom", e.target.value)}
            max={dateTo || undefined}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Delivery date from"
          />
          <span className="text-navy/70">–</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setFilter("dateTo", e.target.value)}
            min={dateFrom || undefined}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Delivery date to"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => {
                setFilter("dateFrom", "");
                setFilter("dateTo", "");
              }}
              className="rounded p-1.5 text-navy/70 hover:text-danger transition-colors"
              title="Clear dates"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Clear active filters */}
        {(statusFilter || urgentOnly || dateFrom || dateTo || customerSearch) && (
          <button
            onClick={() => {
              clearFilters();
              setCustomerSearch("");
            }}
            className="flex items-center gap-1 text-sm text-brand-500 hover:underline"
          >
            <X className="h-3.5 w-3.5" />
            Clear all
          </button>
        )}
      </div>

      {/* Table — urgent rows get red left border via wrapper trick */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              {selectMode && <th className="w-10 px-3 py-3" />}
              <th className="w-4 px-3 py-3" />
              <th
                className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("orderNumber")}
              >
                Order # <SortIcon col="orderNumber" />
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("customer")}
              >
                Customer <SortIcon col="customer" />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Items</th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("total")}
              >
                Total <SortIcon col="total" />
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("status")}
              >
                Status <SortIcon col="status" />
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("deliveryDate")}
              >
                Delivery Date <SortIcon col="deliveryDate" />
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors"
                onClick={() => toggleSort("createdAt")}
              >
                Created <SortIcon col="createdAt" />
              </th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={selectMode ? 10 : 9} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td
                  colSpan={selectMode ? 10 : 9}
                  className="px-4 py-12 text-center text-sm text-danger"
                >
                  Failed to load orders. Please try again.
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={selectMode ? 10 : 9} className="p-0">
                  {statusFilter || urgentOnly || dateFrom || dateTo || customerSearch ? (
                    <EmptyState
                      variant="orders"
                      title="No matching orders"
                      description="No orders match your current search and filters."
                      action={
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setCustomerSearch("");
                            clearFilters();
                          }}
                        >
                          Clear filters
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      variant="orders"
                      title="No orders yet"
                      description="Create an order on behalf of a customer to get started."
                      action={
                        <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                          Create order
                        </Button>
                      }
                    />
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((order) => (
                <tr
                  key={order.id}
                  role="link"
                  tabIndex={0}
                  onClick={() => {
                    if (selectMode) toggleSelect(order.id);
                    else router.push(`/orders/${order.id}`);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (selectMode) toggleSelect(order.id);
                      else router.push(`/orders/${order.id}`);
                    }
                  }}
                  className={cn(
                    "cursor-pointer transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500",
                    order.urgent && "border-l-2 border-l-danger",
                    selected.has(order.id) && "bg-brand-50",
                  )}
                >
                  {selectMode && (
                    <td
                      className="px-3 py-3"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(order.id);
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(order.id)}
                        onChange={() => toggleSelect(order.id)}
                        className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
                      />
                    </td>
                  )}
                  <td className="px-3 py-3">
                    {order.urgent && <AlertTriangle className="h-4 w-4 text-danger" />}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                    {order.orderNumber}
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">
                    {order.customer?.businessName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-navy">{order.lineItems.length}</td>
                  <td className="px-4 py-3 font-medium text-navy">
                    ${Number(order.total).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-3">
                    <Badge status={order.status} />
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {order.requestedDeliveryDate ? (
                      <span className="font-medium text-navy">
                        {(() => {
                          const [y, m, d] = order.requestedDeliveryDate
                            .split("T")[0]
                            .split("-")
                            .map(Number);
                          return new Date(y, m - 1, d).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          });
                        })()}
                      </span>
                    ) : (
                      <span className="text-navy/30">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-navy">
                    {new Date(order.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="View order"
                      aria-label="View order details"
                      onClick={() => router.push(`/orders/${order.id}`)}
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

      {/* Pagination */}
      {meta && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <p className="text-sm text-navy/70">
              {customerSearch
                ? filtered.length > 0
                  ? `Showing ${filtered.length} of ${meta.total} order${meta.total !== 1 ? "s" : ""} (filtered)`
                  : "No orders match your search"
                : meta.total > 0
                  ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total} order${meta.total !== 1 ? "s" : ""}`
                  : "No orders found"}
            </p>
            {!customerSearch && (
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
            )}
          </div>
          {!customerSearch && (meta.totalPages ?? 1) > 1 && (
            <div className="flex items-center gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              {Array.from({ length: Math.min(meta.totalPages ?? 1, 7) }, (_, i) => {
                const totalPages = meta.totalPages ?? 1;
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
                disabled={page >= (meta.totalPages ?? 1)}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      <CreateOrderModal
        isOpen={isCreateOpen}
        onClose={() => {
          setIsCreateOpen(false);
          setResumeDraftId(null);
          setInitialScanCode(null);
        }}
        resumeDraftId={resumeDraftId}
        initialScanCode={initialScanCode}
      />
    </div>
  );
}
