"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Plus,
  Eye,
  Calendar,
  X,
  Loader2,
  FileText,
  Trash2,
  Filter,
  ScanBarcode,
  Sparkles,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
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
import { useProducts } from "@/lib/api/products";
import { useExpenses, useExpenseCategories, useDeleteExpense } from "@/lib/api/finance";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { ScanInvoiceModal } from "@/components/ScanInvoiceModal";
import Link from "next/link";
import { fmt, fmtDate, todayIso } from "@/lib/formatting";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isOverdue(bill: VendorBill) {
  if (!bill.dueDate) return false;
  return (
    bill.status !== "PAID" &&
    bill.status !== "VOID" &&
    new Date(bill.dueDate) < new Date(new Date().toDateString())
  );
}

function dueThisWeek(bill: VendorBill) {
  if (bill.status === "PAID" || bill.status === "VOID" || !bill.dueDate) return false;
  const due = new Date(bill.dueDate);
  const now = new Date();
  const weekEnd = new Date();
  weekEnd.setDate(now.getDate() + 7);
  return due >= now && due <= weekEnd;
}

// ─── Vendor Bill Status badge ──────────────────────────────────────────────────

const STATUS_COLORS: Record<VendorBillStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  RECEIVED: "bg-blue-100 text-blue-700",
  PARTIAL: "bg-yellow-100 text-yellow-700",
  PAID: "bg-green-100 text-green-700",
  VOID: "bg-red-100 text-red-600",
};

function VendorBillStatusBadge({ status }: { status: VendorBillStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", STATUS_COLORS[status])}>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

// ─── KPI chip ─────────────────────────────────────────────────────────────────

function KpiChip({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className={cn(
      "flex flex-col rounded-lg border px-4 py-3 min-w-[160px]",
      danger && Number(value.replace(/[^0-9.]/g, "")) > 0 ? "border-red-200 bg-red-50" : "border-surface-border bg-white",
    )}>
      <span className="text-xs font-medium text-navy/50 uppercase tracking-wider">{label}</span>
      <span className={cn("mt-1 text-xl font-bold", danger && Number(value.replace(/[^0-9.]/g, "")) > 0 ? "text-red-700" : "text-navy")}>{value}</span>
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
  productId: string;
  description: string;
  unit: string;
  qty: string;
  unitCost: string;
}

const emptyLineItem = (): LineItemRow => ({ productId: "", description: "", unit: "", qty: "1", unitCost: "" });

// ─── Product combobox for line items ──────────────────────────────────────────

interface ProductOption {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  averageCost?: string;
  barcode?: string;
}

function ProductCombobox({
  value,
  onChange,
  onCreateNew,
}: {
  value: { productId: string; description: string; unit: string; unitCost: string };
  onChange: (update: Partial<LineItemRow>) => void;
  onCreateNew: (search: string) => void;
}) {
  const [search, setSearch] = React.useState(value.description);
  const [open, setOpen] = React.useState(false);
  const barcodeInputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const { data } = useProducts({ search: search || undefined, limit: 20, isActive: true });
  const products: ProductOption[] = (data as any)?.data ?? [];

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSelect = (p: ProductOption) => {
    onChange({
      productId: p.id,
      description: p.name,
      unit: p.unit,
      unitCost: p.averageCost ? String(parseFloat(p.averageCost).toFixed(4)) : "",
    });
    setSearch(p.name);
    setOpen(false);
  };

  const handleBarcodeScanned = (code: string) => {
    const match = products.find((p) => p.barcode === code);
    if (match) {
      handleSelect(match);
    } else {
      setSearch(code);
      setOpen(true);
    }
  };

  return (
    <div ref={containerRef} className="relative flex gap-1">
      <input
        ref={barcodeInputRef}
        type="text"
        placeholder="Search product or scan barcode…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          if (!value.productId) onChange({ description: e.target.value });
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        className="h-9 w-full rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      <BarcodeScannerButton inputRef={barcodeInputRef} onScan={handleBarcodeScanned} title="Scan product barcode" />
      {open && (
        <div className="absolute left-0 top-10 z-50 w-full rounded-lg border border-surface-border bg-white shadow-dropdown">
          {products.length > 0 ? (
            <ul className="max-h-48 overflow-y-auto py-1">
              {products.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={() => handleSelect(p)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-brand-50 flex items-center justify-between gap-2"
                  >
                    <span>
                      <span className="font-medium text-navy">{p.name}</span>
                      {p.sku && <span className="ml-2 text-xs text-navy/40">{p.sku}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-navy/40">{p.unit}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-3 py-2 text-xs text-navy/50">No products found</div>
          )}
          <div className="border-t border-surface-border px-3 py-2">
            <button
              type="button"
              onMouseDown={() => { setOpen(false); onCreateNew(search); }}
              className="flex w-full items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600"
            >
              <Plus size={14} /> Create &quot;{search || "new product"}&quot;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Create Bill Modal ────────────────────────────────────────────────────────

function CreateBillModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
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

  const [createProductOpen, setCreateProductOpen] = React.useState(false);
  const [createProductForIndex, setCreateProductForIndex] = React.useState<number>(-1);
  const [createProductSearch, setCreateProductSearch] = React.useState("");

  const { data: posData } = usePurchaseOrders(supplierId ? { supplierId } : undefined);
  const purchaseOrders: Array<{ id: string; poNumber: string }> = (posData as any)?.data ?? [];
  const [purchaseOrderId, setPurchaseOrderId] = React.useState("");

  React.useEffect(() => {
    if (isOpen) {
      setSupplierId(""); setPurchaseOrderId(""); setBillDate(todayIso());
      setDueDate(""); setNotes(""); setLineItems([emptyLineItem()]); setErrors({});
    }
  }, [isOpen]);

  React.useEffect(() => { setPurchaseOrderId(""); }, [supplierId]);

  function updateLineItem(i: number, updates: Partial<LineItemRow>) {
    setLineItems((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...updates } : row)));
  }
  function addLineItem() { setLineItems((prev) => [...prev, emptyLineItem()]); }
  function removeLineItem(i: number) { setLineItems((prev) => prev.filter((_, idx) => idx !== i)); }

  const lineTotal = lineItems.reduce((sum, row) => {
    return sum + (parseFloat(row.qty) || 0) * (parseFloat(row.unitCost) || 0);
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
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setErrors({});
    const items: CreateVendorBillItem[] = lineItems.map((row) => ({
      description: row.description.trim(),
      qty: parseFloat(row.qty),
      unitCost: parseFloat(row.unitCost),
    }));
    createBill.mutate(
      { supplierId, purchaseOrderId: purchaseOrderId || undefined, billDate, dueDate, items, notes: notes.trim() || undefined },
      {
        onSuccess: () => { toast({ title: "Vendor bill created", variant: "success" }); onClose(); },
        onError: () => { toast({ title: "Failed to create vendor bill", description: "Please try again.", variant: "error" }); },
      },
    );
  }

  return (
    <>
      <Modal
        open={isOpen}
        onClose={onClose}
        title="New Vendor Bill"
        description="Record a bill received from a supplier."
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={createBill.isPending}>Cancel</Button>
            <Button type="submit" form="create-bill-form" loading={createBill.isPending}>Create Bill</Button>
          </>
        }
      >
        <form id="create-bill-form" onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Supplier</label>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
              className={cn("h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500", errors.supplierId ? "border-danger" : "border-surface-border")}>
              <option value="">Select supplier…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {errors.supplierId && <p className="mt-1 text-xs text-danger">{errors.supplierId}</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">PO # <span className="text-navy/40 font-normal">(optional)</span></label>
            <select value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)} disabled={!supplierId}
              className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50">
              <option value="">No linked PO</option>
              {purchaseOrders.map((po) => <option key={po.id} value={po.id}>{po.poNumber}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">Bill Date</label>
              <input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)}
                className={cn("h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500", errors.billDate ? "border-danger" : "border-surface-border")} />
              {errors.billDate && <p className="mt-1 text-xs text-danger">{errors.billDate}</p>}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">Due Date</label>
              <input type="date" value={dueDate} min={billDate || undefined} onChange={(e) => setDueDate(e.target.value)}
                className={cn("h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500", errors.dueDate ? "border-danger" : "border-surface-border")} />
              {errors.dueDate && <p className="mt-1 text-xs text-danger">{errors.dueDate}</p>}
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium text-navy/80">Line Items</label>
              <button type="button" onClick={addLineItem}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand-500 hover:bg-brand-50 transition-colors">
                <Plus className="h-3.5 w-3.5" /> Add Item
              </button>
            </div>
            {errors.items && <p className="mb-2 text-xs text-danger">{errors.items}</p>}
            <div className="space-y-3">
              {lineItems.map((row, i) => (
                <div key={i} className="rounded-lg border border-surface-border bg-surface-raised p-3 space-y-2">
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-medium text-navy/60">Product</span>
                      {row.productId && <span className="text-xs text-brand-500">{row.unit}</span>}
                    </div>
                    <ProductCombobox
                      value={row}
                      onChange={(updates) => updateLineItem(i, updates)}
                      onCreateNew={(search) => { setCreateProductForIndex(i); setCreateProductSearch(search); setCreateProductOpen(true); }}
                    />
                    {errors[`desc_${i}`] && <p className="mt-1 text-xs text-danger">{errors[`desc_${i}`]}</p>}
                  </div>
                  <div className="grid grid-cols-[1fr_1fr_32px] gap-2 items-end">
                    <div>
                      <label className="mb-1 block text-xs text-navy/50">Qty {row.unit ? `(${row.unit})` : ""}</label>
                      <input type="number" placeholder="1" min="0.001" step="0.001" value={row.qty}
                        onChange={(e) => updateLineItem(i, { qty: e.target.value })}
                        className={cn("h-9 w-full rounded border bg-white px-2.5 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500", errors[`qty_${i}`] ? "border-danger" : "border-surface-border")} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-navy/50">Unit Cost ($)</label>
                      <input type="number" placeholder="0.00" min="0.0001" step="0.0001" value={row.unitCost}
                        onChange={(e) => updateLineItem(i, { unitCost: e.target.value })}
                        className={cn("h-9 w-full rounded border bg-white px-2.5 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500", errors[`cost_${i}`] ? "border-danger" : "border-surface-border")} />
                    </div>
                    <button type="button" onClick={() => removeLineItem(i)} disabled={lineItems.length === 1}
                      className="h-9 rounded p-1 text-navy/30 hover:text-danger transition-colors disabled:opacity-20">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {parseFloat(row.qty) > 0 && parseFloat(row.unitCost) > 0 && (
                    <div className="text-right text-xs text-navy/50">
                      Subtotal: {fmt((parseFloat(row.qty) || 0) * (parseFloat(row.unitCost) || 0))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {lineItems.length > 0 && (
              <div className="mt-3 flex justify-end">
                <span className="text-sm font-semibold text-navy">Total: {fmt(lineTotal)}</span>
              </div>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Notes <span className="text-navy/40 font-normal">(optional)</span></label>
            <textarea rows={3} placeholder="Internal notes about this bill…" value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
        </form>
      </Modal>
      <InlineCreateProductModal
        isOpen={createProductOpen}
        onClose={() => setCreateProductOpen(false)}
        initialName={createProductSearch}
        onCreated={(product) => {
          if (createProductForIndex >= 0) {
            updateLineItem(createProductForIndex, {
              productId: product.id,
              description: product.name,
              unit: product.unit,
              unitCost: product.averageCost ? String(parseFloat(product.averageCost).toFixed(4)) : "",
            });
          }
          setCreateProductOpen(false);
        }}
      />
    </>
  );
}

// ─── Vendor Bills Tab ─────────────────────────────────────────────────────────

function VendorBillsTab() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [sortCol, setSortCol] = React.useState("billDate");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [scanOpen, setScanOpen] = React.useState(false);
  const LIMIT = 20;

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };
  const SortIcon = ({ col }: { col: string }) => {
    if (sortCol !== col) return <ChevronsUpDown className="h-3 w-3 ml-0.5 text-current/40 inline" />;
    return sortDir === "asc" ? <ChevronUp className="h-3 w-3 ml-0.5 inline" /> : <ChevronDown className="h-3 w-3 ml-0.5 inline" />;
  };

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

  // Client-side sort of current page bills
  const sortedBills = React.useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...bills].sort((a: any, b: any) => {
      if (sortCol === "supplier") return dir * ((a.supplier?.name ?? "").localeCompare(b.supplier?.name ?? ""));
      if (sortCol === "dueDate") return dir * ((a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
      if (sortCol === "total") return dir * (Number(a.totalOwed ?? a.total ?? 0) - Number(b.totalOwed ?? b.total ?? 0));
      if (sortCol === "status") return dir * (a.status ?? "").localeCompare(b.status ?? "");
      // billDate (default)
      return dir * ((a.billDate ?? a.createdAt ?? "").localeCompare(b.billDate ?? b.createdAt ?? ""));
    });
  }, [bills, sortCol, sortDir]);

  return (
    <div className="space-y-5">
      {/* Actions row */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => setScanOpen(true)}>
          <Sparkles className="mr-1 h-4 w-4" /> Scan Invoice
        </Button>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setIsCreateOpen(true)}>
          New Bill
        </Button>
      </div>

      {/* KPI row */}
      <div className="flex flex-wrap items-start gap-3">
        <KpiChip label="Total Outstanding" value={fmt(kpis.outstanding)} sub="unpaid balance" danger={kpis.outstanding > 0} />
        <KpiChip label="Due This Week" value={String(kpis.dueThisWeekCount)} sub="bills due in 7 days" />
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
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="h-10 rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500">
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/40" />
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} title="Bill date from"
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500" />
          <span className="text-navy/40">–</span>
          <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} title="Bill date to"
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500" />
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
              className="rounded p-1.5 text-navy/40 hover:text-danger transition-colors" title="Clear dates">
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
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60 cursor-pointer select-none hover:text-navy" onClick={() => toggleSort("supplier")}>Supplier <SortIcon col="supplier" /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">PO #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60 cursor-pointer select-none hover:text-navy" onClick={() => toggleSort("billDate")}>Bill Date <SortIcon col="billDate" /></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60 cursor-pointer select-none hover:text-navy" onClick={() => toggleSort("dueDate")}>Due Date <SortIcon col="dueDate" /></th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60 cursor-pointer select-none hover:text-navy" onClick={() => toggleSort("total")}>Total <SortIcon col="total" /></th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Paid</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/60">Balance</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60 cursor-pointer select-none hover:text-navy" onClick={() => toggleSort("status")}>Status <SortIcon col="status" /></th>
              <th className="w-10 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr><td colSpan={10} className="px-4 py-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/40" /></td></tr>
            ) : isError ? (
              <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-danger">Failed to load vendor bills. Please try again.</td></tr>
            ) : bills.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <FileText className="h-8 w-8 text-navy/20" />
                    <p className="text-sm text-navy/40">No vendor bills match your filters.</p>
                    <button className="text-sm text-brand-500 hover:underline" onClick={() => { setSearch(""); setStatusFilter(""); setDateFrom(""); setDateTo(""); setPage(1); }}>
                      Clear filters
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              sortedBills.map((bill: VendorBill) => {
                const overdue = isOverdue(bill);
                return (
                  <tr key={bill.id} onClick={() => router.push(`/vendor-bills/${bill.id}`)}
                    className={cn("cursor-pointer transition-colors hover:bg-surface-raised", overdue && "border-l-4 border-l-red-400")}>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">{bill.billNumber}</td>
                    <td className="px-4 py-3 font-medium text-navy">{bill.supplier?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-navy/60 font-mono text-xs">{bill.purchaseOrder?.poNumber ?? "—"}</td>
                    <td className="px-4 py-3 text-navy/60">{fmtDate(bill.billDate ?? bill.createdAt)}</td>
                    <td className={cn("px-4 py-3", overdue ? "text-red-600 font-medium" : "text-navy/60")}>
                      {fmtDate(bill.dueDate)}
                      {overdue && <span className="ml-1.5 text-xs font-semibold text-red-500">Overdue</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-navy">{fmt(Number(bill.totalOwed ?? 0))}</td>
                    <td className="px-4 py-3 text-right text-navy/60">{fmt(Number(bill.totalPaid ?? 0))}</td>
                    <td className="px-4 py-3 text-right">
                      {(() => {
                        const bal = Math.max(0, Number(bill.totalOwed ?? 0) - Number(bill.totalPaid ?? 0));
                        return <span className={cn("font-medium", bal > 0 ? "text-danger" : "text-navy/40")}>{fmt(bal)}</span>;
                      })()}
                    </td>
                    <td className="px-4 py-3"><VendorBillStatusBadge status={bill.status} /></td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <button title="View bill" onClick={() => router.push(`/vendor-bills/${bill.id}`)}
                        className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors">
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
          <p className="text-sm text-navy/50">Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total} bills</p>
          <div className="flex items-center gap-1">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
              className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Previous
            </button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              const p = i + 1;
              return (
                <button key={p} onClick={() => setPage(p)}
                  className={cn("rounded border px-3 py-1.5 text-sm font-medium transition-colors", p === page ? "border-brand-500 bg-brand-500 text-white" : "border-surface-border bg-white text-navy hover:bg-surface-raised")}>
                  {p}
                </button>
              );
            })}
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
              className="rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Next
            </button>
          </div>
        </div>
      )}

      <CreateBillModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} />
      <ScanInvoiceModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onCreated={() => { setScanOpen(false); }}
      />
    </div>
  );
}

// ─── Expenses Tab ─────────────────────────────────────────────────────────────

function ExpensesTab() {
  const { toast } = useToast();
  const [page, setPage] = React.useState(1);
  const [categoryId, setCategoryId] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  const { data, isLoading } = useExpenses({ categoryId: categoryId || undefined, from: from || undefined, to: to || undefined, page, limit: 25 });
  const { data: categories } = useExpenseCategories();
  const deleteExpense = useDeleteExpense();

  const expenses = data?.data ?? [];
  const meta = data?.meta;
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

  const handleDelete = async (id: string) => {
    try {
      await deleteExpense.mutateAsync(id);
      toast({ title: "Expense deleted", variant: "success" });
      setConfirmDelete(null);
    } catch {
      toast({ title: "Failed to delete expense", variant: "error" });
    }
  };

  return (
    <div className="space-y-5">
      {/* Actions row */}
      <div className="flex items-center justify-end gap-2">
        <Link href="/finance/expenses/new" className="flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition-colors">
          <Plus className="h-4 w-4" /> New Expense
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-white p-4">
        <Filter className="h-4 w-4 text-navy/40" />
        <select value={categoryId} onChange={e => { setCategoryId(e.target.value); setPage(1); }}
          className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500">
          <option value="">All Categories</option>
          {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }}
          className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
        <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }}
          className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
        {(categoryId || from || to) && (
          <button onClick={() => { setCategoryId(""); setFrom(""); setTo(""); setPage(1); }} className="text-xs text-navy/40 hover:text-danger transition-colors">
            Clear filters
          </button>
        )}
        {!isLoading && meta && <span className="ml-auto text-sm text-navy/60">{meta.total} expenses &middot; {fmt(total)} total</span>}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-surface-border bg-white">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border bg-surface-raised">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Date</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Expense Account</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Description</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Supplier</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Payment Method</th>
                <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Amount</th>
                <th className="px-5 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {expenses.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-sm text-navy/40">No expenses found. <Link href="/finance/expenses/new" className="text-brand-500 hover:underline">Record your first expense.</Link></td></tr>
              )}
              {expenses.map((e) => (
                <tr key={e.id} className="group hover:bg-surface-raised/50 transition-colors">
                  <td className="px-5 py-3 text-navy/70">{fmtDate(e.date)}</td>
                  <td className="px-5 py-3 font-medium text-brand-600">{e.category.name}</td>
                  <td className="px-5 py-3 text-navy/70 max-w-xs truncate">{e.description ?? "—"}</td>
                  <td className="px-5 py-3 text-navy/70">{e.supplier?.name ?? "—"}</td>
                  <td className="px-5 py-3 text-navy/60 capitalize">{e.paymentMethod?.toLowerCase().replace("_", " ") ?? "—"}</td>
                  <td className="px-5 py-3 text-right font-semibold text-navy">{fmt(Number(e.amount))}</td>
                  <td className="px-5 py-3">
                    {confirmDelete === e.id ? (
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleDelete(e.id)} className="text-xs text-danger hover:underline">Delete</button>
                        <span className="text-navy/30">|</span>
                        <button onClick={() => setConfirmDelete(null)} className="text-xs text-navy/40 hover:underline">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmDelete(e.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-navy/30 hover:text-danger">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/60">Page {meta.page} of {meta.totalPages}</p>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised">Previous</button>
            <button onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))} disabled={page === meta.totalPages} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page Content ────────────────────────────────────────────────────────

function PurchasesContent() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Purchases"); }, [setTitle]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = (searchParams.get("tab") ?? "bills") as "bills" | "expenses";

  const setTab = (tab: "bills" | "expenses") => {
    router.push(`/purchases?tab=${tab}`);
  };

  return (
    <div className="space-y-6 p-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold text-navy">Purchases</h1>
        <p className="text-sm text-navy/60">Manage vendor bills and business expenses</p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-xl border border-surface-border bg-surface-raised p-1 w-fit">
        <button
          onClick={() => setTab("bills")}
          className={cn(
            "rounded-lg px-5 py-2 text-sm font-medium transition-colors",
            activeTab === "bills" ? "bg-white text-navy shadow-sm" : "text-navy/60 hover:text-navy",
          )}
        >
          Vendor Bills
        </button>
        <button
          onClick={() => setTab("expenses")}
          className={cn(
            "rounded-lg px-5 py-2 text-sm font-medium transition-colors",
            activeTab === "expenses" ? "bg-white text-navy shadow-sm" : "text-navy/60 hover:text-navy",
          )}
        >
          Expenses
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "bills" ? <VendorBillsTab /> : <ExpensesTab />}
    </div>
  );
}

export default function PurchasesPage() {
  return (
    <React.Suspense fallback={<div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" /></div>}>
      <PurchasesContent />
    </React.Suspense>
  );
}
