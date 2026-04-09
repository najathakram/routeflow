"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Eye, Loader2, Calendar, X, CheckSquare, Trash2, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { PageHeader, Badge, Select, Button, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useOrders, useUpdateOrderStatus, useBulkDeleteOrders, type Order } from "@/lib/api/orders";
import { CreateOrderModal } from "./_components/CreateOrderModal";

// ─── Status filter options ────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING", label: "Pending" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "CANCELLED", label: "Cancelled" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Orders"); }, [setTitle]);

  const statusParam = searchParams.get("status") ?? "";
  const [statusFilter, setStatusFilter] = React.useState(statusParam);
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [urgentOnly, setUrgentOnly] = React.useState(false);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
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
    else { setSortCol(col); setSortDir("asc"); }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortCol !== col) return <ChevronsUpDown className="h-3 w-3 ml-0.5 text-navy/30 inline" />;
    return sortDir === "asc" ? <ChevronUp className="h-3 w-3 ml-0.5 inline" /> : <ChevronDown className="h-3 w-3 ml-0.5 inline" />;
  };
  const { toast } = useToast();
  const updateStatus = useUpdateOrderStatus();
  const bulkDelete = useBulkDeleteOrders();

  const toggleSelect = (id: string) =>
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); setDeleteConfirm(false); };

  const handleBulkCancel = async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      await Promise.all(Array.from(selected).map((id) =>
        updateStatus.mutateAsync({ id, status: "CANCELLED" }),
      ));
      toast({ title: `${selected.size} order${selected.size !== 1 ? "s" : ""} cancelled`, variant: "success" });
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
        toast({ title: `${result.deleted} deleted, ${result.errors.length} failed (only PENDING/CANCELLED orders can be deleted)`, variant: "error" });
      } else {
        toast({ title: `${result.deleted} order${result.deleted !== 1 ? "s" : ""} deleted`, variant: "success" });
      }
      exitSelectMode();
    } catch {
      toast({ title: "Failed to delete orders", variant: "error" });
    } finally {
      setIsDeleting(false);
      setDeleteConfirm(false);
    }
  };

  // Reset page when filters change
  React.useEffect(() => { setPage(1); }, [statusFilter, urgentOnly, dateFrom, dateTo]);

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
      if (q && !o.customer?.businessName?.toLowerCase().includes(q) && !o.orderNumber?.toLowerCase().includes(q)) return false;
      return true;
    });
    return [...list].sort((a, b) => {
      // Urgent always floats to top regardless of sort column
      if (a.urgent && !b.urgent) return -1;
      if (!a.urgent && b.urgent) return 1;
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortCol === "orderNumber") return dir * (a.orderNumber ?? "").localeCompare(b.orderNumber ?? "");
      if (sortCol === "customer") return dir * ((a.customer?.businessName ?? "").localeCompare(b.customer?.businessName ?? ""));
      if (sortCol === "total") return dir * (Number(a.total) - Number(b.total));
      if (sortCol === "status") return dir * (a.status ?? "").localeCompare(b.status ?? "");
      if (sortCol === "deliveryDate") return dir * ((a.requestedDeliveryDate ?? "").localeCompare(b.requestedDeliveryDate ?? ""));
      // default: createdAt
      return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
  }, [orders, customerSearch, sortCol, sortDir]);

  const urgentCount = orders.filter((o) => o.urgent).length;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Orders"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            <Button onClick={() => setIsCreateOpen(true)}>Create Order</Button>
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
            <button onClick={() => setSelected(new Set())} className="text-sm text-navy/50 hover:text-navy transition-colors">
              Deselect all
            </button>
            <Button variant="secondary" leftIcon={<X className="h-4 w-4" />} loading={isCancelling} onClick={handleBulkCancel}>
              Cancel {selected.size}
            </Button>
            {deleteConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-danger font-medium">Delete {selected.size} orders?</span>
                <Button variant="danger" size="sm" loading={isDeleting} onClick={handleBulkDelete}>
                  Confirm Delete
                </Button>
                <button onClick={() => setDeleteConfirm(false)} className="text-sm text-navy/50 hover:text-navy transition-colors">
                  No
                </button>
              </div>
            ) : (
              <Button variant="danger" leftIcon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleteConfirm(true)}>
                Delete {selected.size}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        {selectMode && filtered.length > 0 && (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filtered.every((o) => selected.has(o.id))}
              ref={(el) => { if (el) el.indeterminate = filtered.some((o) => selected.has(o.id)) && !filtered.every((o) => selected.has(o.id)); }}
              onChange={() => {
                if (filtered.every((o) => selected.has(o.id))) setSelected(new Set());
                else setSelected(new Set(filtered.map((o) => o.id)));
              }}
              className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
            />
            <span className="text-sm text-navy/60">Select all</span>
          </label>
        )}
        <input
          type="search"
          placeholder="Search by customer or order #…"
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-48">
          <Select
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        {/* Urgent toggle */}
        <button
          onClick={() => setUrgentOnly((v) => !v)}
          className={cn(
            "flex h-10 items-center gap-2 rounded border px-3 text-sm font-medium transition-colors",
            urgentOnly
              ? "border-danger/40 bg-danger-bg text-danger"
              : "border-surface-border bg-white text-navy/60 hover:text-navy",
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
          <Calendar className="h-4 w-4 text-navy/40" />
          <span className="text-xs text-navy/50 font-medium">Delivery:</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            max={dateTo || undefined}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Delivery date from"
          />
          <span className="text-navy/40">–</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            min={dateFrom || undefined}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Delivery date to"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(""); setDateTo(""); }}
              className="rounded p-1.5 text-navy/40 hover:text-danger transition-colors"
              title="Clear dates"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Table — urgent rows get red left border via wrapper trick */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              {selectMode && <th className="w-10 px-3 py-3" />}
              <th className="w-4 px-3 py-3" />
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors" onClick={() => toggleSort("orderNumber")}>Order # <SortIcon col="orderNumber" /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors" onClick={() => toggleSort("customer")}>Customer <SortIcon col="customer" /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Items</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors" onClick={() => toggleSort("total")}>Total <SortIcon col="total" /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors" onClick={() => toggleSort("status")}>Status <SortIcon col="status" /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors" onClick={() => toggleSort("deliveryDate")}>Delivery Date <SortIcon col="deliveryDate" /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy transition-colors" onClick={() => toggleSort("createdAt")}>Created <SortIcon col="createdAt" /></th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={selectMode ? 10 : 9} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/40" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={selectMode ? 10 : 9} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load orders. Please try again.
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={selectMode ? 10 : 9} className="px-4 py-12 text-center text-sm text-navy/40">
                  No orders match your filters.{" "}
                  <button
                    className="text-brand-500 hover:underline"
                    onClick={() => { setCustomerSearch(""); setStatusFilter(""); setUrgentOnly(false); setDateFrom(""); setDateTo(""); }}
                  >
                    Clear filters
                  </button>
                </td>
              </tr>
            ) : (
              filtered.map((order) => (
                <tr
                  key={order.id}
                  role="link"
                  tabIndex={0}
                  onClick={() => { if (selectMode) toggleSelect(order.id); else router.push(`/orders/${order.id}`); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { if (selectMode) toggleSelect(order.id); else router.push(`/orders/${order.id}`); } }}
                  className={cn(
                    "cursor-pointer transition-colors hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500",
                    order.urgent && "border-l-2 border-l-danger",
                    selected.has(order.id) && "bg-brand-50",
                  )}
                >
                  {selectMode && (
                    <td className="px-3 py-3" onClick={(e) => { e.stopPropagation(); toggleSelect(order.id); }}>
                      <input
                        type="checkbox"
                        checked={selected.has(order.id)}
                        onChange={() => toggleSelect(order.id)}
                        className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
                      />
                    </td>
                  )}
                  <td className="px-3 py-3">
                    {order.urgent && (
                      <AlertTriangle className="h-4 w-4 text-danger" />
                    )}
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
                        {(() => { const [y,m,d] = order.requestedDeliveryDate.split('T')[0].split('-').map(Number); return new Date(y, m-1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); })()}
                      </span>
                    ) : (
                      <span className="text-navy/30">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-navy">
                    {new Date(order.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="View order"
                      aria-label="View order details"
                      onClick={() => router.push(`/orders/${order.id}`)}
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
                ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, meta.total)} of ${meta.total} orders`
                : "No orders found"}
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
          {(meta.totalPages ?? 1) > 1 && (
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
        onClose={() => setIsCreateOpen(false)}
      />
    </div>
  );
}
