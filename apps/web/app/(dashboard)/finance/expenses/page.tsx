"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Eye,
  Calendar,
  X,
  AlertCircle,
  Loader2,
  FileText,
  Trash2,
  Filter,
  Sparkles,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Paperclip,
  Upload,
  ExternalLink,
  CheckSquare,
  PackageCheck,
  CheckCircle2,
} from "lucide-react";
import {
  PageHeader,
  Button,
  cn,
  Modal,
  useToast,
  EmptyState,
  Badge,
  type BadgeVariant,
} from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useClampPage } from "@/lib/hooks/useUrlPage";
import {
  useVendorBills,
  useCreateVendorBill,
  useBulkDeleteVendorBills,
  getDuplicateVendorBillError,
  type VendorBill,
  type VendorBillStatus,
  type CreateVendorBillItem,
  type DuplicateVendorBillInfo,
} from "@/lib/api/vendor-bills";
import { useSuppliers as useInventorySuppliers, usePurchaseOrders } from "@/lib/api/inventory";
import { useProducts } from "@/lib/api/products";
import {
  useExpenses,
  useExpenseCategories,
  useDeleteExpense,
  useUploadExpenseReceipt,
  useDeleteExpenseReceipt,
  useGetExpenseReceiptUrl,
  useExtractExpenseItems,
  useBatchUpdateExpenseStatus,
  type Expense,
  type ExpenseStatus,
} from "@/lib/api/finance";
import { usePreferences, useSavePreferences } from "@/lib/api/users";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { ScanInvoiceModal } from "@/components/ScanInvoiceModal";
import { SupplierSelect } from "@/components/SupplierSelect";
import Link from "next/link";
import { fmt, fmtCalendarDate, fmtDate, todayIso } from "@/lib/formatting";
import { apiClient } from "@/lib/api-client";
import { SELECTABLE_PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@/lib/payment-methods";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isOverdue(bill: VendorBill) {
  if (!bill.dueDate) return false;
  return (
    bill.status !== "PAID" &&
    bill.status !== "VOID" &&
    new Date(bill.dueDate) < new Date(new Date().toDateString())
  );
}

/** Remaining balance on a bill — arithmetic, never status (PARTIAL is overloaded). */
function billBalance(bill: VendorBill) {
  return Math.max(0, Number(bill.totalOwed ?? 0) - Number(bill.totalPaid ?? 0));
}

function dueThisWeek(bill: VendorBill) {
  if (bill.status === "PAID" || bill.status === "VOID" || !bill.dueDate) return false;
  const due = new Date(bill.dueDate);
  const now = new Date();
  const weekEnd = new Date();
  weekEnd.setDate(now.getDate() + 7);
  return due >= now && due <= weekEnd;
}

// ─── Stat tile (Ledger idiom: overline · value · hint) ──────────────────────────

function StatTile({
  label,
  value,
  hint,
  money,
  ring,
}: {
  label: string;
  value: string;
  hint?: string;
  money?: boolean;
  ring?: "warning" | "danger";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-surface-border bg-white p-4 shadow-card",
        ring === "warning" && "border-warning",
        ring === "danger" && "border-danger",
      )}
    >
      <span className="overline block">{label}</span>
      <span
        className={cn(
          "mt-1.5 block text-2xl text-navy",
          money ? "money" : "font-semibold tracking-[-0.02em]",
          ring === "warning" && "text-[#B45309]",
          ring === "danger" && "text-danger",
        )}
      >
        {value}
      </span>
      {hint && <span className="mt-1 block text-xs text-navy/70">{hint}</span>}
    </div>
  );
}

// ─── Purchase-order status → Badge props (PO enum isn't in the shared Badge map) ─

function poBadge(status: string): { variant: BadgeVariant; label: string } {
  switch (status) {
    case "DRAFT":
      return { variant: "neutral", label: "Draft" };
    case "SENT":
      return { variant: "warning", label: "Sent" };
    case "PARTIALLY_RECEIVED":
      return { variant: "info", label: "Partial" };
    case "RECEIVED":
      return { variant: "success", label: "Received" };
    case "CLOSED":
      return { variant: "neutral", label: "Closed" };
    default:
      return { variant: "neutral", label: status };
  }
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

const emptyLineItem = (): LineItemRow => ({
  productId: "",
  description: "",
  unit: "",
  qty: "1",
  unitCost: "",
});

// ─── Product combobox ─────────────────────────────────────────────────────────

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

  const handleBarcodeScanned = async (code: string) => {
    // 1. Try barcode endpoint
    try {
      const res = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`);
      if (res.data?.id) {
        handleSelect(res.data as ProductOption);
        return;
      }
    } catch {
      /* not found */
    }
    // 2. Try exact SKU match from current results
    const skuMatch = products.find((p) => p.sku === code);
    if (skuMatch) {
      handleSelect(skuMatch);
      return;
    }
    // 3. Fall back to first search result
    if (products.length === 1) {
      handleSelect(products[0]);
      return;
    }
    // 4. Open dropdown with code pre-filled
    setSearch(code);
    setOpen(true);
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
      <BarcodeScannerButton
        inputRef={barcodeInputRef}
        onScan={handleBarcodeScanned}
        title="Scan product barcode"
      />
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
                      {p.sku && <span className="ml-2 text-xs text-navy/70">{p.sku}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-navy/70">{p.unit}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-3 py-2 text-xs text-navy/70">No products found</div>
          )}
          <div className="border-t border-surface-border px-3 py-2">
            <button
              type="button"
              onMouseDown={() => {
                setOpen(false);
                onCreateNew(search);
              }}
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

// ─── Duplicate bill banner ────────────────────────────────────────────────────

/**
 * Shown when `POST /vendor-bills` answers 409 DUPLICATE_VENDOR_BILL. Two shapes,
 * because the recovery differs: a DRAFT match is resumable (finish that bill), an
 * already-received match is not (a second one would double stock). Mirrors the
 * banner in ScanInvoiceModal so both entry points read the same.
 */
function DuplicateBillBanner({
  duplicate,
  disabled,
  onCreateAnyway,
}: {
  duplicate: DuplicateVendorBillInfo;
  disabled?: boolean;
  onCreateAnyway: () => void;
}) {
  const resumable = duplicate.resumable;
  const seenOn = duplicate.receivedDate ?? duplicate.billDate;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-2.5",
        resumable ? "border-amber-200 bg-amber-50" : "border-danger/30 bg-danger-bg",
      )}
      data-testid="duplicate-banner"
    >
      <AlertCircle
        className={cn("mt-0.5 h-4 w-4 shrink-0", resumable ? "text-amber-600" : "text-danger")}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs", resumable ? "text-amber-800" : "text-danger")}>
          {resumable ? (
            <>
              <span className="font-semibold">
                A draft bill for this invoice already exists — {duplicate.billNumber},{" "}
                {fmt(duplicate.totalOwed)}.
              </span>{" "}
              Finish that one instead of creating a second bill.
            </>
          ) : (
            <>
              <span className="font-semibold">
                Already recorded as {duplicate.billNumber}
                {seenOn ? ` on ${fmtCalendarDate(seenOn)}` : ""}.
              </span>{" "}
              Creating it again would double stock and the amount owed.
            </>
          )}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a
            href={`/vendor-bills/${duplicate.billId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View existing bill
          </a>
          <button
            type="button"
            onClick={onCreateAnyway}
            disabled={disabled}
            className="rounded-lg border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:border-brand-300 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create anyway
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Create Bill Modal ────────────────────────────────────────────────────────

function CreateBillModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const createBill = useCreateVendorBill();
  const { data: prefs } = usePreferences();
  const savePrefs = useSavePreferences();

  const { data: suppliersData } = useInventorySuppliers();
  const suppliers: Array<{ id: string; name: string }> = suppliersData ?? [];

  const [supplierId, setSupplierId] = React.useState("");
  const [billDate, setBillDate] = React.useState(todayIso());
  const [dueDate, setDueDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lineItems, setLineItems] = React.useState<LineItemRow[]>([emptyLineItem()]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  // The bill the server matched this one against (409). Cleared on every submit so
  // an edited form is judged fresh.
  const [duplicate, setDuplicate] = React.useState<DuplicateVendorBillInfo | null>(null);
  const [createProductOpen, setCreateProductOpen] = React.useState(false);
  const [createProductForIndex, setCreateProductForIndex] = React.useState<number>(-1);
  const [createProductSearch, setCreateProductSearch] = React.useState("");
  const [scanInput, setScanInput] = React.useState("");
  const scanInputRef = React.useRef<HTMLInputElement>(null);
  const lineItemsRef = React.useRef(lineItems);
  React.useEffect(() => {
    lineItemsRef.current = lineItems;
  }, [lineItems]);

  const handleBillScan = React.useCallback(
    async (code: string) => {
      if (!code.trim()) return;
      let product: ProductOption | null = null;
      // 1. barcode endpoint
      try {
        const res = await apiClient.get(`/products/barcode/${encodeURIComponent(code.trim())}`);
        if (res.data?.id) product = res.data as ProductOption;
      } catch {
        /* not found */
      }
      // 2. search by SKU
      if (!product) {
        try {
          const res = await apiClient.get("/products", {
            params: { search: code.trim(), limit: 5, isActive: true },
          });
          const results: ProductOption[] = res.data?.data ?? [];
          product = results.find((p) => p.sku === code.trim()) ?? results[0] ?? null;
        } catch {
          /* ignore */
        }
      }
      if (!product) {
        toast({ title: `Item not found: ${code.trim()}`, variant: "error" });
        setScanInput("");
        setTimeout(() => scanInputRef.current?.focus(), 50);
        return;
      }
      const existing = lineItemsRef.current.findIndex((li) => li.productId === product!.id);
      if (existing >= 0) {
        setLineItems((prev) =>
          prev.map((li, i) =>
            i === existing ? { ...li, qty: String(parseFloat(li.qty || "1") + 1) } : li,
          ),
        );
      } else {
        const newItem: LineItemRow = {
          productId: product.id,
          description: product.name,
          unit: product.unit,
          qty: "1",
          unitCost: product.averageCost ? String(parseFloat(product.averageCost).toFixed(4)) : "",
        };
        setLineItems((prev) => {
          // Replace a single empty item if present
          if (prev.length === 1 && !prev[0].productId && !prev[0].description) return [newItem];
          return [...prev, newItem];
        });
      }
      setScanInput("");
      setTimeout(() => scanInputRef.current?.focus(), 50);
    },
    [toast],
  );

  const { data: posData } = usePurchaseOrders(supplierId ? { supplierId } : undefined);
  const purchaseOrders: Array<{ id: string; poNumber: string }> = (posData as any)?.data ?? [];
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
      setDuplicate(null);
      if (prefs?.["bill.lastSupplierId"]) setSupplierId(prefs["bill.lastSupplierId"]);
    }
  }, [isOpen]);

  React.useEffect(() => {
    setPurchaseOrderId("");
  }, [supplierId]);

  function updateLineItem(i: number, updates: Partial<LineItemRow>) {
    setLineItems((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...updates } : row)));
  }
  function addLineItem() {
    setLineItems((prev) => [...prev, emptyLineItem()]);
  }
  function removeLineItem(i: number) {
    setLineItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  const lineTotal = lineItems.reduce(
    (sum, row) => sum + (parseFloat(row.qty) || 0) * (parseFloat(row.unitCost) || 0),
    0,
  );

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

  function postBill(allowDuplicate: boolean) {
    const items: CreateVendorBillItem[] = lineItems.map((row) => ({
      description: row.description.trim(),
      qty: parseFloat(row.qty),
      unitCost: parseFloat(row.unitCost),
      productId: row.productId || undefined,
    }));
    createBill.mutate(
      {
        supplierId,
        purchaseOrderId: purchaseOrderId || undefined,
        billDate,
        dueDate,
        items,
        notes: notes.trim() || undefined,
        ...(allowDuplicate ? { allowDuplicate: true } : {}),
      },
      {
        onSuccess: () => {
          savePrefs.mutate({ "bill.lastSupplierId": supplierId });
          toast({ title: "Vendor bill created", variant: "success" });
          onClose();
        },
        onError: (err: unknown) => {
          // A match against an existing bill is recoverable in the form (open that
          // bill, or override) — everything else is the server's own explanation.
          const dup = getDuplicateVendorBillError(err);
          if (dup) {
            setDuplicate(dup.duplicate);
            return;
          }
          const raw = (err as { response?: { data?: { message?: string | string[] } } })?.response
            ?.data?.message;
          toast({
            title: "Failed to create vendor bill",
            description: (Array.isArray(raw) ? raw.join(" ") : raw) || "Please try again.",
            variant: "error",
          });
        },
      },
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setDuplicate(null);
    postBill(false);
  }

  return (
    <>
      <Modal
        open={isOpen}
        onClose={onClose}
        title="New Inventory Purchase"
        description="Record a supplier bill for inventory received."
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
          {duplicate && (
            <DuplicateBillBanner
              duplicate={duplicate}
              disabled={createBill.isPending}
              onCreateAnyway={() => postBill(true)}
            />
          )}
          {/* ── Barcode scan strip ── */}
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2">
            <span className="text-xs font-medium text-brand-600 shrink-0">Scan item:</span>
            <input
              ref={scanInputRef}
              type="text"
              placeholder="Scan barcode or enter SKU then Enter…"
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  handleBillScan(scanInput);
                }
              }}
              className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/30 outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Supplier</label>
            <SupplierSelect
              value={supplierId}
              onChange={setSupplierId}
              suppliers={suppliers}
              placeholder="Select supplier…"
              className={cn("h-10", errors.supplierId ? "border-danger" : undefined)}
            />
            {errors.supplierId && <p className="mt-1 text-xs text-danger">{errors.supplierId}</p>}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">
              PO # <span className="text-navy/70 font-normal">(optional)</span>
            </label>
            <select
              value={purchaseOrderId}
              onChange={(e) => setPurchaseOrderId(e.target.value)}
              disabled={!supplierId}
              className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
            >
              <option value="">No linked PO</option>
              {purchaseOrders.map((po) => (
                <option key={po.id} value={po.id}>
                  {po.poNumber}
                </option>
              ))}
            </select>
          </div>
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
            <div className="space-y-3">
              {lineItems.map((row, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-surface-border bg-surface-raised p-3 space-y-2"
                >
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-medium text-navy/70">Product</span>
                      {row.productId && <span className="text-xs text-brand-500">{row.unit}</span>}
                    </div>
                    <ProductCombobox
                      value={row}
                      onChange={(updates) => updateLineItem(i, updates)}
                      onCreateNew={(search) => {
                        setCreateProductForIndex(i);
                        setCreateProductSearch(search);
                        setCreateProductOpen(true);
                      }}
                    />
                    {errors[`desc_${i}`] && (
                      <p className="mt-1 text-xs text-danger">{errors[`desc_${i}`]}</p>
                    )}
                  </div>
                  <div className="grid grid-cols-[1fr_1fr_32px] gap-2 items-end">
                    <div>
                      <label className="mb-1 block text-xs text-navy/70">
                        Qty {row.unit ? `(${row.unit})` : ""}
                      </label>
                      <input
                        type="number"
                        placeholder="1"
                        min="0.001"
                        step="0.001"
                        value={row.qty}
                        onChange={(e) => updateLineItem(i, { qty: e.target.value })}
                        className={cn(
                          "h-9 w-full rounded border bg-white px-2.5 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                          errors[`qty_${i}`] ? "border-danger" : "border-surface-border",
                        )}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-navy/70">Unit Cost ($)</label>
                      <input
                        type="number"
                        placeholder="0.00"
                        min="0.0001"
                        step="0.0001"
                        value={row.unitCost}
                        onChange={(e) => updateLineItem(i, { unitCost: e.target.value })}
                        className={cn(
                          "h-9 w-full rounded border bg-white px-2.5 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
                          errors[`cost_${i}`] ? "border-danger" : "border-surface-border",
                        )}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLineItem(i)}
                      disabled={lineItems.length === 1}
                      className="h-9 rounded p-1 text-navy/30 hover:text-danger transition-colors disabled:opacity-20"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  {parseFloat(row.qty) > 0 && parseFloat(row.unitCost) > 0 && (
                    <div className="text-right text-xs text-navy/70">
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
            <label className="mb-1.5 block text-sm font-medium text-navy/80">
              Notes <span className="text-navy/70 font-normal">(optional)</span>
            </label>
            <textarea
              rows={3}
              placeholder="Internal notes about this purchase…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
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
              unitCost: product.averageCost
                ? String(parseFloat(product.averageCost).toFixed(4))
                : "",
            });
          }
          setCreateProductOpen(false);
        }}
      />
    </>
  );
}

// ─── Inventory Purchases Tab ──────────────────────────────────────────────────

function InventoryPurchasesTab() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = React.useState("");
  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [needsMappingOnly, setNeedsMappingOnly] = React.useState(false);
  const [page, setPage] = useUrlPage();
  const [sortCol, setSortCol] = React.useState("billDate");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");
  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [scanOpen, setScanOpen] = React.useState(false);
  // Selected bills as id → remaining balance captured at selection time. A Map rather
  // than a Set because the selection survives paging: the mark-paid preview has to cover
  // every selected id, including ones whose row is no longer on the visible page.
  const [selectedBills, setSelectedBills] = React.useState<Map<string, number>>(new Map());
  const [markPaidMethod, setMarkPaidMethod] = React.useState("ACH");
  const [markPaidDate, setMarkPaidDate] = React.useState(todayIso());
  const bulkDelete = useBulkDeleteVendorBills();
  const qc = useQueryClient();
  const bulkMarkPaid = useMutation<
    {
      paid: number;
      totalAmount: number;
      skipped: { id: string; billNumber?: string; reason: string }[];
    },
    Error,
    { ids: string[]; method: string; paidAt?: string }
  >({
    mutationFn: (body) =>
      apiClient.post("/bookkeeping/bills/bulk-mark-paid", body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
    },
  });
  const { toast } = useToast();
  const LIMIT = 20;

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("asc");
    }
  };
  const SortIcon = ({ col }: { col: string }) => {
    if (sortCol !== col)
      return <ChevronsUpDown className="h-3 w-3 ml-0.5 text-current/40 inline" />;
    return sortDir === "asc" ? (
      <ChevronUp className="h-3 w-3 ml-0.5 inline" />
    ) : (
      <ChevronDown className="h-3 w-3 ml-0.5 inline" />
    );
  };

  const toggleSelect = (bill: VendorBill) => {
    setSelectedBills((prev) => {
      const next = new Map(prev);
      if (next.has(bill.id)) next.delete(bill.id);
      else next.set(bill.id, billBalance(bill));
      return next;
    });
  };
  const toggleSelectAll = () => {
    const deselect = allOnPageSelected;
    setSelectedBills((prev) => {
      const next = new Map(prev);
      for (const b of sortedBills as VendorBill[]) {
        if (deselect) next.delete(b.id);
        else next.set(b.id, billBalance(b));
      }
      return next;
    });
  };
  const handleBulkDelete = async () => {
    if (selectedBills.size === 0) return;
    if (
      !confirm(
        `Delete ${selectedBills.size} selected bill(s)? Only DRAFT and VOID bills can be deleted.`,
      )
    )
      return;
    try {
      const result = await bulkDelete.mutateAsync(Array.from(selectedBills.keys()));
      toast({
        title: `${result.deleted} bill(s) deleted${result.skipped.length > 0 ? `, ${result.skipped.length} skipped (received/paid)` : ""}`,
        variant: result.deleted > 0 ? "success" : "error",
      });
      setSelectedBills(new Map());
    } catch {
      toast({ title: "Failed to delete bills", variant: "error" });
    }
  };

  const handleBulkMarkPaid = async () => {
    if (selectedBills.size === 0) return;
    try {
      const result = await bulkMarkPaid.mutateAsync({
        ids: Array.from(selectedBills.keys()),
        method: markPaidMethod,
        paidAt: markPaidDate || undefined,
      });
      toast({
        title: `${result.paid} bill(s) marked paid — ${fmt(result.totalAmount)}${
          result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ""
        }`,
        variant: result.paid > 0 ? "success" : "error",
      });
      setSelectedBills(new Map());
    } catch {
      toast({ title: "Failed to mark bills paid", variant: "error" });
    }
  };

  const { data, isLoading, isError } = useVendorBills({
    status: statusFilter || undefined,
    search: debouncedSearch || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    needsMapping: needsMappingOnly || undefined,
    page,
    limit: LIMIT,
  });

  const bills = data?.data ?? [];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);
  const needsMappingCount = meta?.needsMappingCount ?? 0;

  const { data: allData } = useVendorBills({ limit: 999 });
  const all = allData?.data ?? [];

  const kpis = React.useMemo(() => {
    let outstanding = 0;
    let unpaidCount = 0;
    let dueThisWeekCount = 0;
    let dueThisWeekAmount = 0;
    let spend30d = 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    for (const b of all) {
      const owed = Number((b as any).totalOwed ?? (b as any).total ?? 0);
      const paid = Number((b as any).totalPaid ?? (b as any).amountPaid ?? 0);
      const bal = Math.max(0, owed - paid);
      outstanding += bal;
      if (bal > 0 && (b as any).status !== "VOID") unpaidCount++;
      if (dueThisWeek(b)) {
        dueThisWeekCount++;
        dueThisWeekAmount += bal;
      }
      const billDate = (b as any).billDate ?? (b as any).createdAt;
      if (billDate && new Date(billDate) >= cutoff && (b as any).status !== "VOID") {
        spend30d += owed;
      }
    }
    return { outstanding, unpaidCount, dueThisWeekCount, dueThisWeekAmount, spend30d };
  }, [all]);

  const totalPages = meta?.totalPages ?? 1;

  const sortedBills = React.useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...bills].sort((a: any, b: any) => {
      if (sortCol === "supplier")
        return dir * (a.supplier?.name ?? "").localeCompare(b.supplier?.name ?? "");
      if (sortCol === "dueDate") return dir * (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
      if (sortCol === "total")
        return dir * (Number(a.totalOwed ?? a.total ?? 0) - Number(b.totalOwed ?? b.total ?? 0));
      if (sortCol === "status") return dir * (a.status ?? "").localeCompare(b.status ?? "");
      return dir * (a.billDate ?? a.createdAt ?? "").localeCompare(b.billDate ?? b.createdAt ?? "");
    });
  }, [bills, sortCol, sortDir]);

  const allOnPageSelected =
    sortedBills.length > 0 && sortedBills.every((b: VendorBill) => selectedBills.has(b.id));

  // Preview total for bulk mark-paid: computed from totalOwed − totalPaid per selected
  // bill, never from status (VendorBillStatus.PARTIAL is overloaded — short-received
  // and part-paid both write it). Iterates the SELECTION, not the visible page, so it
  // still matches what the request pays after the operator has paged around; rows still
  // on screen use their live balance, off-page ones the balance captured at selection.
  const markPaidPreview = React.useMemo(() => {
    const onPage = new Map(sortedBills.map((b: VendorBill) => [b.id, billBalance(b)] as const));
    let count = 0;
    let total = 0;
    for (const [id, captured] of Array.from(selectedBills.entries())) {
      const bal = onPage.get(id) ?? captured;
      if (bal > 0.001) {
        count++;
        total += bal;
      }
    }
    return { count, total };
  }, [sortedBills, selectedBills]);

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
        Inventory purchases are recorded as vendor bills. When a bill is <strong>received</strong>,
        stock is updated and product average costs are recalculated automatically.
      </div>

      {/* Actions row */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => setScanOpen(true)}>
          <Sparkles className="mr-1 h-4 w-4" /> Scan Invoice
        </Button>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setIsCreateOpen(true)}>
          New Purchase
        </Button>
      </div>

      {/* Bulk action bar */}
      {selectedBills.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-300 bg-brand-50 px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selectedBills.size} bill{selectedBills.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSelectedBills(new Map())}
              className="text-sm text-navy/70 hover:text-navy transition-colors"
            >
              Deselect all
            </button>
            <select
              value={markPaidMethod}
              onChange={(e) => setMarkPaidMethod(e.target.value)}
              title="Payment method"
              className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {SELECTABLE_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={markPaidDate}
              onChange={(e) => setMarkPaidDate(e.target.value)}
              title="Payment date"
              className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <Button
              variant="danger"
              leftIcon={<Trash2 className="h-4 w-4" />}
              loading={bulkDelete.isPending}
              onClick={() => void handleBulkDelete()}
            >
              Delete
            </Button>
            <Button
              leftIcon={<CheckCircle2 className="h-4 w-4" />}
              loading={bulkMarkPaid.isPending}
              disabled={markPaidPreview.count === 0}
              onClick={() => void handleBulkMarkPaid()}
            >
              Mark {markPaidPreview.count} paid — {fmt(markPaidPreview.total)}
            </Button>
          </div>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Open Bills"
          value={fmt(kpis.outstanding)}
          hint={`${kpis.unpaidCount} bill${kpis.unpaidCount === 1 ? "" : "s"} unpaid`}
          money
        />
        <StatTile
          label="Due This Week"
          value={fmt(kpis.dueThisWeekAmount)}
          hint={`${kpis.dueThisWeekCount} bill${kpis.dueThisWeekCount === 1 ? "" : "s"} due in 7 days`}
          money
          ring={kpis.dueThisWeekCount > 0 ? "warning" : undefined}
        />
        <button
          type="button"
          onClick={() => {
            setNeedsMappingOnly((v) => !v);
            setPage(1);
          }}
          disabled={needsMappingCount === 0 && !needsMappingOnly}
          title="Draft bills with no items or unmapped lines — their costs won't reach inventory until items are mapped and the bill is received"
          className={cn(
            "rounded-lg border p-4 text-left shadow-card transition-colors disabled:cursor-default",
            needsMappingOnly
              ? "border-danger bg-danger-bg"
              : needsMappingCount > 0
                ? "border-danger bg-white hover:bg-danger-bg/40"
                : "border-surface-border bg-white",
          )}
        >
          <span className="overline block">Unlinked Items{needsMappingOnly ? " ✕" : ""}</span>
          <span
            className={cn(
              "mt-1.5 block text-2xl font-semibold tracking-[-0.02em]",
              needsMappingCount > 0 ? "text-danger" : "text-navy",
            )}
          >
            {needsMappingCount}
          </span>
          <span className="mt-1 block text-xs text-navy/70">bills awaiting item mapping</span>
        </button>
        <StatTile
          label="Spend, 30d"
          value={fmt(kpis.spend30d)}
          hint="vendor bills in the last 30 days"
          money
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by bill # or supplier…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="h-10 w-64 rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="h-10 rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-navy/70" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
            title="Bill date from"
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
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
            title="Bill date to"
            className="h-10 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-surface-border text-brand-500 accent-brand-500"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Bill #</th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  onClick={() => toggleSort("supplier")}
                >
                  Supplier <SortIcon col="supplier" />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">PO #</th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  onClick={() => toggleSort("billDate")}
                >
                  Bill Date <SortIcon col="billDate" />
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  onClick={() => toggleSort("dueDate")}
                >
                  Due Date <SortIcon col="dueDate" />
                </th>
                <th
                  className="px-4 py-3 text-right text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  onClick={() => toggleSort("total")}
                >
                  Total <SortIcon col="total" />
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Paid</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Balance</th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-navy/70 cursor-pointer select-none hover:text-navy"
                  onClick={() => toggleSort("status")}
                >
                  Status <SortIcon col="status" />
                </th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border bg-white">
              {isLoading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-sm text-danger">
                    Failed to load. Please try again.
                  </td>
                </tr>
              ) : bills.length === 0 ? (
                <tr>
                  <td colSpan={11} className="p-0">
                    {search || statusFilter || dateFrom || dateTo ? (
                      <EmptyState
                        variant="data"
                        title="No matching purchases"
                        description="No inventory purchases match your current search and filters."
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
                        variant="data"
                        title="No purchases yet"
                        description="Record an inventory purchase to track supplier bills and expenses."
                        action={
                          <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                            New purchase
                          </Button>
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : (
                sortedBills.map((bill: VendorBill) => {
                  const overdue = isOverdue(bill);
                  return (
                    <tr
                      key={bill.id}
                      onClick={() => router.push(`/vendor-bills/${bill.id}`)}
                      className={cn(
                        "cursor-pointer transition-colors hover:bg-surface-raised",
                        overdue && "border-l-4 border-l-red-400",
                        selectedBills.has(bill.id) && "bg-brand-50",
                      )}
                    >
                      <td className="w-10 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedBills.has(bill.id)}
                          onChange={() => toggleSelect(bill)}
                          className="h-4 w-4 rounded border-surface-border text-brand-500 accent-brand-500"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                        {bill.billNumber}
                        {bill.status === "DRAFT" &&
                          ((bill.items ?? []).length === 0 ||
                            (bill.items ?? []).some((i) => !i.productId)) && (
                            <span
                              title="No items or unmapped lines — receiving won't update inventory costs"
                              className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                            >
                              needs items
                            </span>
                          )}
                      </td>
                      <td className="px-4 py-3 font-medium text-navy">
                        {bill.supplier?.name ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-navy font-mono text-xs">
                        {(bill as any).purchaseOrder?.poNumber ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-navy">
                        {fmtCalendarDate(bill.billDate ?? bill.createdAt)}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-3",
                          overdue ? "text-red-600 font-medium" : "text-navy",
                        )}
                      >
                        {fmtCalendarDate(bill.dueDate)}
                        {overdue && (
                          <span className="ml-1.5 text-xs font-semibold text-red-500">Overdue</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-navy">
                        {fmt(Number(bill.totalOwed ?? 0))}
                      </td>
                      <td className="px-4 py-3 text-right text-navy">
                        {fmt(Number(bill.totalPaid ?? 0))}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {(() => {
                          const bal = Math.max(
                            0,
                            Number(bill.totalOwed ?? 0) - Number(bill.totalPaid ?? 0),
                          );
                          return (
                            <span
                              className={cn("font-medium", bal > 0 ? "text-danger" : "text-navy")}
                            >
                              {fmt(bal)}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <Badge status={bill.status} />
                      </td>
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          title="View bill"
                          onClick={() => router.push(`/vendor-bills/${bill.id}`)}
                          className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
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
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            Showing {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, meta.total)} of {meta.total}{" "}
            bills
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
      <ScanInvoiceModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onCreated={() => {
          setScanOpen(false);
        }}
      />
    </div>
  );
}

// ─── Purchase Orders Tab ──────────────────────────────────────────────────────

interface PORow {
  id: string;
  poNumber: string;
  status: string;
  supplier?: { id: string; name: string };
  expectedDate?: string;
  createdAt?: string;
  totalAmount?: number;
  items?: Array<{ qtyOrdered: number; unitCost: number }>;
}

const PO_STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "SENT", label: "Sent" },
  { value: "PARTIALLY_RECEIVED", label: "Partial" },
  { value: "RECEIVED", label: "Received" },
  { value: "CLOSED", label: "Closed" },
];

function poTotal(po: PORow): number {
  if (po.totalAmount != null) return Number(po.totalAmount);
  return (po.items ?? []).reduce(
    (sum, i) => sum + Number(i.qtyOrdered ?? 0) * Number(i.unitCost ?? 0),
    0,
  );
}

function PurchaseOrdersTab() {
  const [statusFilter, setStatusFilter] = React.useState("");
  const { data, isLoading, isError } = usePurchaseOrders(
    statusFilter ? { status: statusFilter } : undefined,
  );
  const orders: PORow[] = (data as any)?.data ?? [];

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
        Purchase orders track what&apos;s on order with suppliers. Receiving a PO updates stock; the
        resulting supplier bill appears under <strong>Vendor Bills</strong>.
      </div>

      {/* Chip-style status filters */}
      <div className="flex flex-wrap items-center gap-2">
        {PO_STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              statusFilter === f.value
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-surface-border bg-white text-navy hover:bg-surface-raised",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-surface-border">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">PO #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Supplier</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Status</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-navy/70">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border bg-white">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-navy/70" />
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-danger">
                  Failed to load. Please try again.
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-0">
                  <EmptyState
                    variant="data"
                    title="No purchase orders"
                    description={
                      statusFilter
                        ? "No purchase orders match this status."
                        : "Purchase orders you raise with suppliers will appear here."
                    }
                    action={
                      statusFilter ? (
                        <Button variant="secondary" size="sm" onClick={() => setStatusFilter("")}>
                          Clear filter
                        </Button>
                      ) : undefined
                    }
                  />
                </td>
              </tr>
            ) : (
              orders.map((po) => {
                const b = poBadge(po.status);
                return (
                  <tr key={po.id} className="transition-colors hover:bg-surface-raised">
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-navy">
                      {po.poNumber}
                    </td>
                    <td className="px-4 py-3 font-medium text-navy">{po.supplier?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-navy">
                      {fmtDate(po.createdAt ?? po.expectedDate)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={b.variant} label={b.label} />
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-navy">
                      {fmt(poTotal(po))}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Other Expenses Tab ───────────────────────────────────────────────────────

function OtherExpensesTab() {
  const { toast } = useToast();
  const [page, setPage] = useUrlPage();
  const [categoryId, setCategoryId] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);
  const [uploadingFor, setUploadingFor] = React.useState<string | null>(null);
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [detailExpense, setDetailExpense] = React.useState<Expense | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const { data, isLoading } = useExpenses({
    categoryId: categoryId || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    limit: 25,
  });
  const { data: categories } = useExpenseCategories();
  const deleteExpense = useDeleteExpense();
  const uploadReceipt = useUploadExpenseReceipt();
  const deleteReceipt = useDeleteExpenseReceipt();
  const getReceiptUrl = useGetExpenseReceiptUrl();
  const extractItems = useExtractExpenseItems();
  const batchStatus = useBatchUpdateExpenseStatus();

  const expenses = (data?.data ?? []) as Expense[];
  const meta = data?.meta;
  useClampPage(setPage, page, meta?.totalPages);
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const allChecked = expenses.length > 0 && expenses.every((e) => selected.has(e.id));

  const handleBatchStatus = async (status: ExpenseStatus) => {
    if (selected.size === 0) return;
    try {
      const res = await batchStatus.mutateAsync({ ids: Array.from(selected), status });
      toast({
        title: `${res.updated} expense${res.updated !== 1 ? "s" : ""} marked ${status.toLowerCase()}`,
        variant: "success",
      });
      exitSelect();
    } catch {
      toast({ title: "Failed to update expenses", variant: "error" });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteExpense.mutateAsync(id);
      toast({ title: "Expense deleted", variant: "success" });
      setConfirmDelete(null);
    } catch {
      toast({ title: "Failed to delete expense", variant: "error" });
    }
  };

  const triggerUpload = (expenseId: string) => {
    setUploadingFor(expenseId);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadingFor) return;
    e.target.value = "";
    try {
      await uploadReceipt.mutateAsync({ id: uploadingFor, file });
      toast({ title: "Receipt uploaded", variant: "success" });
    } catch {
      toast({ title: "Failed to upload receipt", variant: "error" });
    } finally {
      setUploadingFor(null);
    }
  };

  const handleViewReceipt = async (expenseId: string) => {
    try {
      const { url } = await getReceiptUrl.mutateAsync(expenseId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast({ title: "Failed to fetch receipt URL", variant: "error" });
    }
  };

  const handleDeleteReceipt = async (expenseId: string) => {
    try {
      await deleteReceipt.mutateAsync(expenseId);
      toast({ title: "Receipt removed", variant: "success" });
    } catch {
      toast({ title: "Failed to remove receipt", variant: "error" });
    }
  };

  const handleExtract = async (expenseId: string) => {
    try {
      await extractItems.mutateAsync(expenseId);
      toast({
        title: "Items extracted",
        description: "Line items have been populated from the receipt.",
        variant: "success",
      });
    } catch (err: any) {
      toast({
        title: "Extraction failed",
        description: err?.response?.data?.message ?? "Please check the receipt quality.",
        variant: "error",
      });
    }
  };

  return (
    <div className="space-y-5">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Actions row */}
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          className="flex items-center gap-2 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-medium text-navy hover:bg-surface-raised transition-colors"
        >
          {selectMode ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
          {selectMode ? "Cancel" : "Select"}
        </button>
        <Link
          href="/finance/expenses/new"
          className="flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 transition-colors"
        >
          <Plus className="h-4 w-4" /> New Expense
        </Link>
      </div>

      {/* Bulk action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-brand-300 bg-brand-50 px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selected.size} expense{selected.size !== 1 ? "s" : ""} selected
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
              leftIcon={<PackageCheck className="h-4 w-4" />}
              loading={batchStatus.isPending}
              onClick={() => handleBatchStatus("RECEIVED")}
            >
              Mark Received
            </Button>
            <Button
              leftIcon={<CheckCircle2 className="h-4 w-4" />}
              loading={batchStatus.isPending}
              onClick={() => handleBatchStatus("PAID")}
            >
              Mark Paid
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-white p-4">
        <Filter className="h-4 w-4 text-navy/70" />
        <select
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All Categories</option>
          {categories?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setPage(1);
          }}
          className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setPage(1);
          }}
          className="h-9 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {(categoryId || from || to) && (
          <button
            onClick={() => {
              setCategoryId("");
              setFrom("");
              setTo("");
              setPage(1);
            }}
            className="text-xs text-navy/70 hover:text-danger transition-colors"
          >
            Clear filters
          </button>
        )}
        {!isLoading && meta && (
          <span className="ml-auto text-sm text-navy/70">
            {meta.total} expenses · {fmt(total)} total
          </span>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-surface-border bg-white">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border bg-surface-raised">
                {selectMode && (
                  <th className="px-3 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={() => {
                        if (allChecked) setSelected(new Set());
                        else setSelected(new Set(expenses.map((e) => e.id)));
                      }}
                      className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
                    />
                  </th>
                )}
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/70">
                  Date
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/70">
                  Category
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/70">
                  Description
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/70">
                  Supplier
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/70">
                  Status
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/70">
                  Receipt
                </th>
                <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/70">
                  Amount
                </th>
                <th className="px-5 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {expenses.length === 0 && (
                <tr>
                  <td
                    colSpan={selectMode ? 9 : 8}
                    className="px-5 py-10 text-center text-sm text-navy/70"
                  >
                    No expenses found.{" "}
                    <Link href="/finance/expenses/new" className="text-brand-500 hover:underline">
                      Record your first expense.
                    </Link>
                  </td>
                </tr>
              )}
              {expenses.map((e) => (
                <tr
                  key={e.id}
                  className="group hover:bg-surface-raised/50 transition-colors cursor-pointer"
                  onClick={(ev) => {
                    // Don't open modal when clicking on action buttons or in select mode
                    const target = ev.target as HTMLElement;
                    if (selectMode) {
                      toggleSelect(e.id);
                      return;
                    }
                    if (target.closest("button,a,input")) return;
                    setDetailExpense(e);
                  }}
                >
                  {selectMode && (
                    <td className="px-3 py-3" onClick={(ev) => ev.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={() => toggleSelect(e.id)}
                        className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
                      />
                    </td>
                  )}
                  <td className="px-5 py-3 text-navy/70">{fmtCalendarDate(e.date)}</td>
                  <td className="px-5 py-3 font-medium text-brand-600">
                    {e.category?.name ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-navy/70 max-w-xs truncate">
                    {e.description ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-navy/70">{e.supplier?.name ?? "—"}</td>
                  <td className="px-5 py-3">
                    <Badge status={e.status ?? "PENDING"} />
                  </td>
                  {/* Receipt column */}
                  <td className="px-5 py-3">
                    {!e.receiptKey ? (
                      <button
                        onClick={() => triggerUpload(e.id)}
                        disabled={uploadReceipt.isPending && uploadingFor === e.id}
                        className="flex items-center gap-1.5 rounded-full border border-dashed border-amber-400 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors"
                      >
                        <Paperclip className="h-3 w-3" />
                        Add receipt
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleViewReceipt(e.id)}
                          title="View receipt"
                          className="rounded p-1 text-brand-500 hover:bg-brand-50 transition-colors"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => triggerUpload(e.id)}
                          title="Replace receipt"
                          className="rounded p-1 text-navy/70 hover:bg-surface-raised transition-colors"
                        >
                          <Upload className="h-3.5 w-3.5" />
                        </button>
                        {!e.isItemized && (
                          <button
                            onClick={() => handleExtract(e.id)}
                            title="Extract line items from receipt"
                            disabled={extractItems.isPending}
                            className="rounded p-1 text-purple-500 hover:bg-purple-50 transition-colors disabled:opacity-40"
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {e.vendorBillId && (
                          <Link
                            href={`/finance/vendor-bills/${e.vendorBillId}`}
                            title="View in Vendor Bills"
                            className="rounded p-1 text-teal-600 hover:bg-teal-50 transition-colors"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        )}
                        <button
                          onClick={() => handleDeleteReceipt(e.id)}
                          title="Remove receipt"
                          className="rounded p-1 text-navy/30 hover:text-danger transition-colors"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right font-semibold text-navy">
                    {fmt(Number(e.amount))}
                  </td>
                  <td className="px-5 py-3">
                    {confirmDelete === e.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleDelete(e.id)}
                          className="text-xs text-danger hover:underline"
                        >
                          Delete
                        </button>
                        <span className="text-navy/30">|</span>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="text-xs text-navy/70 hover:underline"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(e.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-navy/30 hover:text-danger"
                      >
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
          <p className="text-sm text-navy/70">
            Page {meta.page} of {meta.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page === meta.totalPages}
              className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <ExpenseDetailModal expense={detailExpense} onClose={() => setDetailExpense(null)} />
    </div>
  );
}

// ─── Expense Detail Modal ────────────────────────────────────────────────────

function ExpenseDetailModal({
  expense,
  onClose,
}: {
  expense: Expense | null;
  onClose: () => void;
}) {
  const getReceiptUrl = useGetExpenseReceiptUrl();
  const [receiptUrl, setReceiptUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    setReceiptUrl(null);
    if (expense?.id && expense.receiptKey) {
      getReceiptUrl
        .mutateAsync(expense.id)
        .then((r) => setReceiptUrl(r.url))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expense?.id]);

  if (!expense) return null;
  const Field = ({ label, value }: { label: string; value: React.ReactNode }) =>
    value == null || value === "" ? null : (
      <div>
        <p className="text-xs uppercase tracking-wide text-navy/70">{label}</p>
        <p className="mt-0.5 text-sm text-navy">{value}</p>
      </div>
    );

  return (
    <Modal open={!!expense} onClose={onClose} title="Expense Details">
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-2xl font-semibold text-navy">{fmt(Number(expense.amount))}</p>
            <p className="text-sm text-navy/70">{fmtCalendarDate(expense.date)}</p>
          </div>
          <Badge status={expense.status ?? "PENDING"} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Category" value={expense.category?.name} />
          <Field label="Supplier" value={expense.supplier?.name} />
          <Field label="Customer" value={expense.customer?.businessName} />
          <Field label="Payment Method" value={expense.paymentMethod} />
          <Field label="Reference #" value={expense.referenceNumber} />
          <Field label="Employee" value={expense.employeeName} />
          {expense.isMileage && (
            <>
              <Field
                label="Distance"
                value={
                  expense.distance != null
                    ? `${expense.distance} ${expense.mileageUnit ?? ""}`
                    : null
                }
              />
              <Field
                label="Mileage Rate"
                value={
                  expense.mileageRateSnapshot != null ? `${expense.mileageRateSnapshot}` : null
                }
              />
            </>
          )}
          <Field label="Billable" value={expense.isBillable ? "Yes" : null} />
          <Field
            label="Received At"
            value={expense.receivedAt ? fmtDate(expense.receivedAt) : null}
          />
          <Field label="Paid At" value={expense.paidAt ? fmtDate(expense.paidAt) : null} />
          <Field label="Created At" value={expense.createdAt ? fmtDate(expense.createdAt) : null} />
        </div>

        {expense.description && (
          <Field
            label="Description"
            value={<span className="whitespace-pre-wrap">{expense.description}</span>}
          />
        )}
        {expense.notes && (
          <Field
            label="Notes"
            value={<span className="whitespace-pre-wrap">{expense.notes}</span>}
          />
        )}

        {expense.lineItems && expense.lineItems.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wide text-navy/70 mb-2">Line Items</p>
            <div className="rounded-lg border border-surface-border divide-y divide-surface-border">
              {expense.lineItems.map((li, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-navy/80">{li.account || li.notes || "Item"}</span>
                  <span className="font-medium text-navy">{fmt(Number(li.amount))}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {expense.receiptKey && (
          <div>
            <p className="text-xs uppercase tracking-wide text-navy/70 mb-2">Receipt</p>
            {receiptUrl ? (
              expense.receiptMimeType === "application/pdf" ? (
                <a
                  href={receiptUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-surface-border px-3 py-2 text-sm text-brand-600 hover:bg-brand-50"
                >
                  <FileText className="h-4 w-4" /> Open PDF (
                  {expense.receiptOriginalName ?? "receipt"})
                </a>
              ) : (
                <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
                  <img
                    src={receiptUrl}
                    alt="receipt"
                    className="max-h-64 rounded-lg border border-surface-border"
                  />
                </a>
              )
            ) : (
              <p className="text-sm text-navy/70">Loading receipt…</p>
            )}
          </div>
        )}

        {expense.vendorBillId && (
          <Link
            href={`/finance/vendor-bills/${expense.vendorBillId}`}
            className="inline-flex items-center gap-2 text-sm text-brand-600 hover:underline"
          >
            <ExternalLink className="h-4 w-4" /> View linked vendor bill
          </Link>
        )}
      </div>
    </Modal>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type ExpensesTab = "inventory" | "pos" | "other";

function ExpensesContent() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Bills & Purchasing");
  }, [setTitle]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = (searchParams.get("tab") ?? "inventory") as ExpensesTab;

  const setTab = (tab: ExpensesTab) => {
    router.push(`/finance/expenses?tab=${tab}`);
  };

  // Count badges for the tab strip — read-only, reuses existing list hooks.
  const { data: billsData } = useVendorBills({ limit: 999 });
  const billsCount = billsData?.meta?.total ?? billsData?.data?.length;
  const { data: posData } = usePurchaseOrders();
  const posCount = (posData as any)?.meta?.total ?? (posData as any)?.data?.length;

  const TabButton = ({
    tab,
    label,
    count,
  }: {
    tab: ExpensesTab;
    label: string;
    count?: number;
  }) => (
    <button
      onClick={() => setTab(tab)}
      className={cn(
        "flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium transition-colors",
        activeTab === tab ? "bg-white text-navy shadow-sm" : "text-navy/70 hover:text-navy",
      )}
    >
      {label}
      {count != null && (
        <span className={cn("money text-xs", activeTab === tab ? "text-navy/70" : "text-navy/40")}>
          {count}
        </span>
      )}
    </button>
  );

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Bills & Purchasing"
        subtitle="One hub for vendor bills, purchase orders and inventory spend — supplier payments happen here."
      />

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-xl border border-surface-border bg-surface-raised p-1 w-fit">
        <TabButton tab="inventory" label="Vendor Bills" count={billsCount} />
        <TabButton tab="pos" label="Purchase Orders" count={posCount} />
        <TabButton tab="other" label="Other Expenses" />
      </div>

      {activeTab === "inventory" ? (
        <InventoryPurchasesTab />
      ) : activeTab === "pos" ? (
        <PurchaseOrdersTab />
      ) : (
        <OtherExpensesTab />
      )}
    </div>
  );
}

export default function ExpensesPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
        </div>
      }
    >
      <ExpensesContent />
    </React.Suspense>
  );
}
