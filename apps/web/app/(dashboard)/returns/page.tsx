"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Eye, Loader2, FileText, Trash2, RotateCcw, DollarSign, Calendar } from "lucide-react";
import { PageHeader, Button, cn, Modal, useToast, EmptyState } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useDebounce } from "@/lib/hooks/useDebounce";
import {
  useReturns,
  useCreateReturn,
  type Return,
  type ReturnStatus,
  type ReturnReason,
  type CreateReturnItemDto,
} from "@/lib/api/returns";
import { useCustomers } from "@/lib/api/customers";
import { useOrders, type Order } from "@/lib/api/orders";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<ReturnStatus, string> = {
  PENDING: "bg-yellow-100 text-yellow-700",
  APPROVED: "bg-blue-100 text-blue-700",
  IN_TRANSIT: "bg-purple-100 text-purple-700",
  RECEIVED: "bg-green-100 text-green-700",
  REFUNDED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-red-100 text-red-600",
  CANCELLED: "bg-gray-100 text-gray-500",
  PROCESSED: "bg-teal-100 text-teal-700",
};

const STATUS_LABELS: Record<ReturnStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  IN_TRANSIT: "In Transit",
  RECEIVED: "Received",
  REFUNDED: "Refunded",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  PROCESSED: "Processed",
};

function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        STATUS_COLORS[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

// ─── Reason label ─────────────────────────────────────────────────────────────

const REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED: "Damaged",
  WRONG_ITEM: "Wrong Item",
  EXCESS_ORDER: "Excess / Overdelivery",
  CUSTOMER_REFUSED: "Customer Refused",
  QUALITY_ISSUE: "Quality Issue",
};

// ─── Filter options ───────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "IN_TRANSIT", label: "In Transit" },
  { value: "RECEIVED", label: "Received" },
  { value: "REFUNDED", label: "Refunded" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

const REASON_OPTIONS = [
  { value: "", label: "All Reasons" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "WRONG_ITEM", label: "Wrong Item" },
  { value: "EXCESS_ORDER", label: "Excess / Overdelivery" },
  { value: "CUSTOMER_REFUSED", label: "Customer Refused" },
  { value: "QUALITY_ISSUE", label: "Quality Issue" },
];

// ─── Create Return Modal ──────────────────────────────────────────────────────

interface ReturnItemRow {
  productId: string;
  productName: string;
  orderedQty: number;
  qty: string;
  notes: string;
}

function CreateReturnModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const createReturn = useCreateReturn();

  const [customerId, setCustomerId] = React.useState("");
  const [customerSearch, setCustomerSearch] = React.useState("");
  const [orderId, setOrderId] = React.useState("");
  const [reason, setReason] = React.useState<ReturnReason | "">("");
  const [notes, setNotes] = React.useState("");
  const [returnItems, setReturnItems] = React.useState<ReturnItemRow[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const { data: customersData } = useCustomers(
    customerSearch ? { search: customerSearch } : { search: "" },
  );
  const customers: Array<{ id: string; businessName: string }> =
    (customersData as any)?.data ?? customersData ?? [];

  const { data: ordersData, isLoading: ordersLoading } = useOrders(
    customerId ? { customerId, status: "DELIVERED" } : undefined,
  );
  const orders: Order[] = (ordersData as any)?.data ?? [];

  React.useEffect(() => {
    if (isOpen) {
      setCustomerId("");
      setCustomerSearch("");
      setOrderId("");
      setReason("");
      setNotes("");
      setReturnItems([]);
      setErrors({});
    }
  }, [isOpen]);

  React.useEffect(() => {
    setOrderId("");
    setReturnItems([]);
  }, [customerId]);

  React.useEffect(() => {
    if (!orderId) {
      setReturnItems([]);
      return;
    }
    const order = orders.find((o) => o.id === orderId);
    if (!order) return;
    setReturnItems(
      order.lineItems.map((item) => ({
        productId: item.productId,
        productName: item.product?.name ?? item.productId,
        orderedQty: Number(item.qty),
        qty: "",
        notes: "",
      })),
    );
  }, [orderId]);

  function updateReturnItem(i: number, field: "qty" | "notes", value: string) {
    setReturnItems((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)),
    );
  }

  const selectedReturnItems = returnItems.filter((r) => r.qty && parseFloat(r.qty) > 0);

  function validate() {
    const errs: Record<string, string> = {};
    if (!customerId) errs.customerId = "Select a customer.";
    if (!orderId) errs.orderId = "Select an order.";
    if (!reason) errs.reason = "Select a return reason.";
    if (selectedReturnItems.length === 0) errs.items = "Enter a quantity for at least one item.";
    selectedReturnItems.forEach((row, i) => {
      const qty = parseFloat(row.qty);
      if (isNaN(qty) || qty <= 0) errs[`qty_${i}`] = "Qty must be > 0.";
      if (qty > row.orderedQty) errs[`qty_${i}`] = `Cannot exceed ordered qty (${row.orderedQty}).`;
    });
    return errs;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});

    const items: CreateReturnItemDto[] = selectedReturnItems.map((row) => ({
      productId: row.productId,
      qty: parseFloat(row.qty),
      notes: row.notes.trim() || undefined,
    }));

    createReturn.mutate(
      {
        customerId,
        orderId,
        reason: reason as ReturnReason,
        notes: notes.trim() || undefined,
        items,
      },
      {
        onSuccess: () => {
          toast({ title: "Return request created", variant: "success" });
          onClose();
        },
        onError: () => {
          toast({
            title: "Failed to create return",
            description: "Please try again.",
            variant: "error",
          });
        },
      },
    );
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="New Return / RMA"
      description="Create a return request for a delivered order."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createReturn.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="create-return-form" loading={createReturn.isPending}>
            Create Return
          </Button>
        </>
      }
    >
      <form id="create-return-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        {/* Customer */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Customer<span className="text-danger ml-0.5">*</span></label>
          <input
            type="search"
            placeholder="Search customers…"
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
            className="mb-1.5 h-9 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className={cn(
              "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              errors.customerId ? "border-danger" : "border-surface-border",
            )}
          >
            <option value="">Select customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.businessName}</option>
            ))}
          </select>
          {errors.customerId && (
            <p className="mt-1 text-xs text-danger">{errors.customerId}</p>
          )}
        </div>

        {/* Order */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Order<span className="text-danger ml-0.5">*</span></label>
          <select
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            disabled={!customerId || ordersLoading}
            className={cn(
              "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50",
              errors.orderId ? "border-danger" : "border-surface-border",
            )}
          >
            <option value="">{customerId && ordersLoading ? "Loading orders…" : "Select delivered order…"}</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>{o.orderNumber}</option>
            ))}
          </select>
          {errors.orderId && <p className="mt-1 text-xs text-danger">{errors.orderId}</p>}
        </div>

        {/* Return Reason */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Return Reason<span className="text-danger ml-0.5">*</span></label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as ReturnReason | "")}
            className={cn(
              "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              errors.reason ? "border-danger" : "border-surface-border",
            )}
          >
            <option value="">Select reason…</option>
            {Object.entries(REASON_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          {errors.reason && <p className="mt-1 text-xs text-danger">{errors.reason}</p>}
        </div>

        {/* Items to return */}
        {returnItems.length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-navy/80">
              Items to Return
            </label>
            {errors.items && <p className="mb-2 text-xs text-danger">{errors.items}</p>}
            <div className="overflow-hidden rounded-lg border border-surface-border">
              <table className="w-full text-sm">
                <thead className="border-b border-surface-border bg-surface-raised">
                  <tr>
                    <th className="px-3 py-2.5 text-left text-xs font-medium text-navy/60">Product</th>
                    <th className="px-3 py-2.5 text-center text-xs font-medium text-navy/60">Ordered</th>
                    <th className="px-3 py-2.5 text-center text-xs font-medium text-navy/60">Return Qty</th>
                    <th className="px-3 py-2.5 text-left text-xs font-medium text-navy/60">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {returnItems.map((row, i) => (
                    <tr key={row.productId}>
                      <td className="px-3 py-2 text-navy font-medium">{row.productName}</td>
                      <td className="px-3 py-2 text-center text-navy/60">{row.orderedQty}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          placeholder="0"
                          min="0"
                          max={row.orderedQty}
                          step="1"
                          value={row.qty}
                          onChange={(e) => updateReturnItem(i, "qty", e.target.value)}
                          className={cn(
                            "h-8 w-20 rounded border bg-white px-2 text-sm text-center text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                            errors[`qty_${i}`] ? "border-danger" : "border-surface-border",
                          )}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          placeholder="Condition / notes…"
                          value={row.notes}
                          onChange={(e) => updateReturnItem(i, "notes", e.target.value)}
                          className="h-8 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* General notes */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Notes <span className="text-navy/40 font-normal">(optional)</span>
          </label>
          <textarea
            rows={3}
            placeholder="Additional notes about this return…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReturnsPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Returns"); }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [reasonFilter, setReasonFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = React.useState(1);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const LIMIT = 20;

  const { data, isLoading, isError, refetch } = useReturns({
    status: statusFilter || undefined,
    reason: reasonFilter || undefined,
    search: debouncedSearch || undefined,
    page,
    limit: LIMIT,
  });

  // Unfiltered summary query for KPI cards
  const { data: summaryData } = useReturns({ limit: 500 });
  const allReturns: Return[] = Array.isArray(summaryData) ? (summaryData as Return[]) : (summaryData?.data ?? []);
  const pendingCount = allReturns.filter((r) => r.status === "PENDING").length;
  const now = new Date();
  const thisMonthCount = allReturns.filter((r) => {
    const d = new Date(r.createdAt);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  const totalReturnValue = allReturns.reduce((sum, r) => {
    return sum + r.items.reduce((s, i) => s + (i.unitPrice ?? 0) * i.qty, 0);
  }, 0);

  // Handle both paginated { data: [], meta: {} } and plain array responses
  const returns: Return[] = Array.isArray(data) ? (data as Return[]) : (data?.data ?? []);
  const meta = Array.isArray(data) ? undefined : data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Returns"
        action={
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setIsCreateOpen(true)}
          >
            New Return
          </Button>
        }
      />

      {/* KPI summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-navy/50">Pending Review</p>
            <RotateCcw className="h-4 w-4 text-yellow-500" />
          </div>
          <p className="mt-2 text-2xl font-bold text-navy">{pendingCount}</p>
          <p className="text-xs text-navy/40">awaiting approval</p>
        </div>
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-navy/50">Total Return Value</p>
            <DollarSign className="h-4 w-4 text-brand-500" />
          </div>
          <p className="mt-2 text-2xl font-bold text-navy">
            ${totalReturnValue.toFixed(2)}
          </p>
          <p className="text-xs text-navy/40">across all returns</p>
        </div>
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-navy/50">This Month</p>
            <Calendar className="h-4 w-4 text-brand-500" />
          </div>
          <p className="mt-2 text-2xl font-bold text-navy">{thisMonthCount}</p>
          <p className="text-xs text-navy/40">returns created</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by return # or customer / order…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="h-10 w-72 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="h-10 rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={reasonFilter}
          onChange={(e) => { setReasonFilter(e.target.value); setPage(1); }}
          className="h-10 rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {REASON_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {(statusFilter || reasonFilter || search) && (
          <button
            onClick={() => { setStatusFilter(""); setReasonFilter(""); setSearch(""); setPage(1); }}
            className="text-sm text-navy/50 hover:text-danger transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Return #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Order #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Date</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-navy/60">Items</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Reason</th>
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
                <td colSpan={8} className="px-4 py-12 text-center">
                  <p className="text-sm text-danger">Failed to load returns.</p>
                  <button
                    onClick={() => refetch()}
                    className="mt-2 text-sm text-brand-500 hover:underline"
                  >
                    Try again
                  </button>
                </td>
              </tr>
            ) : returns.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <FileText className="h-8 w-8 text-navy/20" />
                    {(statusFilter || reasonFilter || search) ? (
                      <>
                        <p className="text-sm text-navy/40">No returns match your filters.</p>
                        <button
                          className="text-sm text-brand-500 hover:underline"
                          onClick={() => {
                            setSearch("");
                            setStatusFilter("");
                            setReasonFilter("");
                            setPage(1);
                          }}
                        >
                          Clear filters
                        </button>
                      </>
                    ) : (
                      <>
                        <EmptyState
                          variant="returns"
                          title="No returns yet"
                          description="Returns will appear here when customers report damaged, wrong, or excess items."
                          action={
                            <button className="text-sm text-brand-600 hover:underline" onClick={() => setIsCreateOpen(true)}>
                              Create a return
                            </button>
                          }
                        />
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              returns.map((ret: Return) => (
                <tr
                  key={ret.id}
                  onClick={() => router.push(`/returns/${ret.id}`)}
                  className="cursor-pointer transition-colors hover:bg-surface-raised"
                >
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                    {ret.returnNumber}
                  </td>
                  <td className="px-4 py-3 font-medium text-navy">
                    {ret.customer?.businessName ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-navy/60">
                    {ret.order?.orderNumber ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-navy/60">
                    {fmtDate(ret.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-center text-navy/60">
                    {ret.items.length}
                  </td>
                  <td className="px-4 py-3 text-navy/60">
                    {REASON_LABELS[ret.reason]}
                  </td>
                  <td className="px-4 py-3">
                    <ReturnStatusBadge status={ret.status} />
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="View return"
                      onClick={() => router.push(`/returns/${ret.id}`)}
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
            Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total} returns
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

      <CreateReturnModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
    </div>
  );
}
