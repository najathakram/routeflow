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
  Trash2,
} from "lucide-react";
import { PageHeader, Button, cn, Modal, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useVendorBills,
  useCreateVendorBill,
  type VendorBill,
  type VendorBillStatus,
  type CreateVendorBillItem,
} from "@/lib/api/vendor-bills";
import { useSuppliers, usePurchaseOrders } from "@/lib/api/inventory";

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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isOverdue(bill: VendorBill) {
  return (
    bill.status !== "PAID" &&
    bill.status !== "VOID" &&
    new Date(bill.dueDate) < new Date(new Date().toDateString())
  );
}

function dueThisWeek(bill: VendorBill) {
  if (bill.status === "PAID" || bill.status === "VOID") return false;
  const due = new Date(bill.dueDate);
  const now = new Date();
  const weekEnd = new Date();
  weekEnd.setDate(now.getDate() + 7);
  return due >= now && due <= weekEnd;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<VendorBillStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  RECEIVED: "bg-blue-100 text-blue-700",
  PARTIAL: "bg-yellow-100 text-yellow-700",
  PAID: "bg-green-100 text-green-700",
  VOID: "bg-red-100 text-red-600",
};

function VendorBillStatusBadge({ status }: { status: VendorBillStatus }) {
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
  sub,
  danger,
}: {
  label: string;
  value: string;
  sub?: string;
  danger?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border px-4 py-3 min-w-[160px]",
        danger && Number(value.replace(/[^0-9.]/g, "")) > 0
          ? "border-red-200 bg-red-50"
          : "border-surface-border bg-white",
      )}
    >
      <span className="text-xs font-medium text-navy/50 uppercase tracking-wider">{label}</span>
      <span
        className={cn(
          "mt-1 text-xl font-bold",
          danger && Number(value.replace(/[^0-9.]/g, "")) > 0 ? "text-red-700" : "text-navy",
        )}
      >
        {value}
      </span>
      {sub && <span className="text-xs text-navy/40 mt-0.5">{sub}</span>}
    </div>
  );
}

// ─── Status filter options ─────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "RECEIVED", label: "Received" },
  { value: "PARTIAL", label: "Partial" },
  { value: "PAID", label: "Paid" },
  { value: "VOID", label: "Void" },
];

// ─── Line item row ─────────────────────────────────────────────────────────────

interface LineItemRow {
  description: string;
  qty: string;
  unitCost: string;
}

const emptyLineItem = (): LineItemRow => ({ description: "", qty: "1", unitCost: "" });

// ─── Create Bill Modal ────────────────────────────────────────────────────────

function CreateBillModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const createBill = useCreateVendorBill();

  const { data: suppliersData } = useSuppliers();
  const suppliers: Array<{ id: string; name: string }> = suppliersData ?? [];

  const [supplierId, setSupplierId] = React.useState("");
  const [billDate, setBillDate] = React.useState(todayIso());
  const [dueDate, setDueDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lineItems, setLineItems] = React.useState<LineItemRow[]>([emptyLineItem()]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const { data: posData } = usePurchaseOrders(
    supplierId ? { supplierId } : undefined,
  );
  const purchaseOrders: Array<{ id: string; poNumber: string }> =
    (posData as any)?.data ?? [];
  const [purchaseOrderId, setPurchaseOrderId] = React.useState("");

  React.useEffect(() => {
    if (isOpen) {
      setSupplierId("");
      setPurchaseOrderId("");
      setBillDate(todayIso());
      setDueDate("");
      setNotes("");
      setLineItems([emptyLineItem()]);
      setErrors({});
    }
  }, [isOpen]);

  React.useEffect(() => {
    setPurchaseOrderId("");
  }, [supplierId]);

  function updateLineItem(i: number, field: keyof LineItemRow, value: string) {
    setLineItems((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)),
    );
  }

  function addLineItem() {
    setLineItems((prev) => [...prev, emptyLineItem()]);
  }

  function removeLineItem(i: number) {
    setLineItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  const lineTotal = lineItems.reduce((sum, row) => {
    const qty = parseFloat(row.qty) || 0;
    const cost = parseFloat(row.unitCost) || 0;
    return sum + qty * cost;
  }, 0);

  function validate() {
    const errs: Record<string, string> = {};
    if (!supplierId) errs.supplierId = "Select a supplier.";
    if (!billDate) errs.billDate = "Bill date is required.";
    if (!dueDate) errs.dueDate = "Due date is required.";
    if (lineItems.length === 0) errs.items = "Add at least one line item.";
    lineItems.forEach((row, i) => {
      if (!row.description.trim()) errs[`desc_${i}`] = "Description required.";
      if (!row.qty || parseFloat(row.qty) <= 0) errs[`qty_${i}`] = "Qty > 0.";
      if (!row.unitCost || parseFloat(row.unitCost) <= 0) errs[`cost_${i}`] = "Cost > 0.";
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

    const items: CreateVendorBillItem[] = lineItems.map((row) => ({
      description: row.description.trim(),
      qty: parseFloat(row.qty),
      unitCost: parseFloat(row.unitCost),
    }));

    createBill.mutate(
      {
        supplierId,
        purchaseOrderId: purchaseOrderId || undefined,
        billDate,
        dueDate,
        items,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast({ title: "Vendor bill created", variant: "success" });
          onClose();
        },
        onError: () => {
          toast({ title: "Failed to create vendor bill", description: "Please try again.", variant: "error" });
        },
      },
    );
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="New Vendor Bill"
      description="Record a bill received from a supplier."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createBill.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="create-bill-form" loading={createBill.isPending}>
            Create Bill
          </Button>
        </>
      }
    >
      <form id="create-bill-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        {/* Supplier */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Supplier</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className={cn(
              "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              errors.supplierId ? "border-danger" : "border-surface-border",
            )}
          >
            <option value="">Select supplier…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {errors.supplierId && <p className="mt-1 text-xs text-danger">{errors.supplierId}</p>}
        </div>

        {/* PO # (optional) */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            PO # <span className="text-navy/40 font-normal">(optional)</span>
          </label>
          <select
            value={purchaseOrderId}
            onChange={(e) => setPurchaseOrderId(e.target.value)}
            disabled={!supplierId}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
          >
            <option value="">No linked PO</option>
            {purchaseOrders.map((po) => (
              <option key={po.id} value={po.id}>{po.poNumber}</option>
            ))}
          </select>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Bill Date</label>
            <input
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              className={cn(
                "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                errors.billDate ? "border-danger" : "border-surface-border",
              )}
            />
            {errors.billDate && <p className="mt-1 text-xs text-danger">{errors.billDate}</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Due Date</label>
            <input
              type="date"
              value={dueDate}
              min={billDate || undefined}
              onChange={(e) => setDueDate(e.target.value)}
              className={cn(
                "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                errors.dueDate ? "border-danger" : "border-surface-border",
              )}
            />
            {errors.dueDate && <p className="mt-1 text-xs text-danger">{errors.dueDate}</p>}
          </div>
        </div>

        {/* Line items */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-navy/80">Line Items</label>
            <button
              type="button"
              onClick={addLineItem}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand-500 hover:bg-brand-50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> Add Item
            </button>
          </div>
          {errors.items && <p className="mb-2 text-xs text-danger">{errors.items}</p>}
          <div className="space-y-2">
            {lineItems.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_80px_100px_32px] gap-2 items-start">
                <div>
                  <input
                    type="text"
                    placeholder="Description"
                    value={row.description}
                    onChange={(e) => updateLineItem(i, "description", e.target.value)}
                    className={cn(
                      "h-9 w-full rounded border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                      errors[`desc_${i}`] ? "border-danger" : "border-surface-border",
                    )}
                  />
                </div>
                <div>
                  <input
                    type="number"
                    placeholder="Qty"
                    min="0.01"
                    step="0.01"
                    value={row.qty}
                    onChange={(e) => updateLineItem(i, "qty", e.target.value)}
                    className={cn(
                      "h-9 w-full rounded border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                      errors[`qty_${i}`] ? "border-danger" : "border-surface-border",
                    )}
                  />
                </div>
                <div>
                  <input
                    type="number"
                    placeholder="Unit Cost"
                    min="0.01"
                    step="0.01"
                    value={row.unitCost}
                    onChange={(e) => updateLineItem(i, "unitCost", e.target.value)}
                    className={cn(
                      "h-9 w-full rounded border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                      errors[`cost_${i}`] ? "border-danger" : "border-surface-border",
                    )}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeLineItem(i)}
                  disabled={lineItems.length === 1}
                  className="mt-1.5 rounded p-1 text-navy/30 hover:text-danger transition-colors disabled:opacity-20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          {lineItems.length > 0 && (
            <div className="mt-3 flex justify-end">
              <span className="text-sm font-semibold text-navy">
                Total: {fmt.format(lineTotal)}
              </span>
            </div>
          )}
        </div>

        {/* Notes */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Notes <span className="text-navy/40 font-normal">(optional)</span>
          </label>
          <textarea
            rows={3}
            placeholder="Internal notes about this bill…"
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

export default function VendorBillsPage() {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Vendor Bills"); }, [setTitle]);

  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const LIMIT = 20;

  const { data, isLoading, isError } = useVendorBills({
    status: statusFilter || undefined,
    search: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    limit: LIMIT,
  });

  const bills = data?.data ?? [];
  const meta = data?.meta;

  // KPI data from unfiltered full set
  const { data: allData } = useVendorBills({ limit: 999 });
  const all = allData?.data ?? [];

  const kpis = React.useMemo(() => {
    let outstanding = 0;
    let dueThisWeekCount = 0;
    for (const b of all) {
      const owed = Number((b as any).totalOwed ?? (b as any).total ?? 0);
      const paid = Number((b as any).totalPaid ?? (b as any).amountPaid ?? 0);
      outstanding += Math.max(0, owed - paid);
      if (dueThisWeek(b)) dueThisWeekCount++;
    }
    return { outstanding, dueThisWeekCount };
  }, [all]);

  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Vendor Bills"
        action={
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setIsCreateOpen(true)}
          >
            New Bill
          </Button>
        }
      />

      {/* KPI row */}
      <div className="flex flex-wrap items-start gap-3">
        <KpiChip
          label="Total Outstanding"
          value={fmt.format(kpis.outstanding)}
          sub="unpaid balance"
          danger={kpis.outstanding > 0}
        />
        <KpiChip
          label="Due This Week"
          value={String(kpis.dueThisWeekCount)}
          sub="bills due in 7 days"
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by bill # or supplier…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
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
        {/* Date range */}
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/40" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Bill date from"
          />
          <span className="text-navy/40">–</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            title="Bill date to"
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
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Bill #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Supplier</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">PO #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Bill Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Due Date</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Total</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Paid</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Balance</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Status</th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/40" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load vendor bills. Please try again.
                </td>
              </tr>
            ) : bills.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <FileText className="h-8 w-8 text-navy/20" />
                    <p className="text-sm text-navy/40">No vendor bills match your filters.</p>
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
              bills.map((bill: VendorBill) => {
                const overdue = isOverdue(bill);
                return (
                  <tr
                    key={bill.id}
                    onClick={() => router.push(`/vendor-bills/${bill.id}`)}
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-surface-raised",
                      overdue && "border-l-4 border-l-red-400",
                    )}
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                      {bill.billNumber}
                    </td>
                    <td className="px-4 py-3 font-medium text-navy">
                      {bill.supplier?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-navy/60 font-mono text-xs">
                      {bill.purchaseOrder?.poNumber ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-navy/60">
                      {fmtDate((bill as any).billDate ?? bill.createdAt)}
                    </td>
                    <td className={cn("px-4 py-3", overdue ? "text-red-600 font-medium" : "text-navy/60")}>
                      {fmtDate(bill.dueDate)}
                      {overdue && <span className="ml-1.5 text-xs font-semibold text-red-500">Overdue</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-navy">
                      {fmt.format(Number((bill as any).totalOwed ?? bill.total ?? 0))}
                    </td>
                    <td className="px-4 py-3 text-right text-navy/60">
                      {fmt.format(Number((bill as any).totalPaid ?? bill.amountPaid ?? 0))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(() => {
                        const owed = Number((bill as any).totalOwed ?? bill.total ?? 0);
                        const paid = Number((bill as any).totalPaid ?? bill.amountPaid ?? 0);
                        const bal = Math.max(0, owed - paid);
                        return (
                          <span className={cn("font-medium", bal > 0 ? "text-danger" : "text-navy/40")}>
                            {fmt.format(bal)}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      <VendorBillStatusBadge status={bill.status} />
                    </td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        title="View bill"
                        onClick={() => router.push(`/vendor-bills/${bill.id}`)}
                        className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/50">
            Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total} bills
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

      <CreateBillModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
    </div>
  );
}
