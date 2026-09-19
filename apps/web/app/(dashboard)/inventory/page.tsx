"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, X, Info, Sparkles, Search, SlidersHorizontal, DollarSign } from "lucide-react";
import { Badge, Button, Modal, PageHeader, cn, useToast } from "@routeflow/ui/web";
import { SearchableProductPicker } from "@/components/SearchableProductPicker";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { archivedMessage, resolveProductByCode } from "@/lib/barcode-resolve";
import { usePageTitle } from "@/lib/page-title-context";
import { useUrlFilters } from "@/lib/hooks/useUrlFilters";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { unitsLabel } from "@/lib/stock-label";
import {
  useStockOverview,
  useSuppliers,
  useRecordPurchase,
  useRecordAdjustment,
  useCreateSupplier,
  useUpdateSupplier,
  usePurchaseOrders,
  useForecasting,
  useUpdateReorderSettings,
  useInventoryValuation,
  useBulkSetCostBasis,
  useRecomputeCosts,
  type RecomputeCostsResult,
} from "@/lib/api/inventory";
import { useProducts, type CostingMethod } from "@/lib/api/products";
import { useTrackedCategories } from "@/lib/api/tracked-categories";
import { useVendorBills } from "@/lib/api/vendor-bills";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { RegulatedScopeTabs } from "@/components/RegulatedScopeTabs";
import { ScanInvoiceModal } from "@/components/ScanInvoiceModal";
import { StockCountTab } from "@/components/inventory/StockCountTab";
import { SetCostModal } from "@/components/SetCostModal";
import { VariantSplitModal } from "@/components/VariantSplitModal";
import { SupplierSelect } from "@/components/SupplierSelect";
import { useSortableData } from "@/lib/use-sortable-data";
import { SortableTh } from "@/components/SortableTh";
import { PurchaseOrdersTab } from "./_components/PurchaseOrdersTab";
import { CreatePOModal } from "./_components/PurchaseOrdersCreateModal";
import type { Supplier } from "./_components/purchase-orders-shared";

const DECIMAL_UNITS = ["kg", "g", "liter", "litre", "l", "oz", "lb", "pound", "ml"];
function isDecimalUnit(unit: string) {
  return DECIMAL_UNITS.includes(unit.toLowerCase());
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface StockItem {
  id: string;
  name: string;
  sku?: string;
  category?: string;
  unit: string;
  currentStock: number;
  averageCost: number | null;
  totalValue: number | null;
  isActive: boolean;
  unitsPerBox?: number | null;
  trackedCategoryId?: string | null;
  /** Additive: `getStockOverview` already selects this, just not previously
   *  typed here — needed so a row's "Assign to variants" split (PR-D) can
   *  hide the cost-override field for STANDARD-costed generics. */
  costingMethod?: CostingMethod;
}

/** Parent/variant lookup built off the full product catalog (PR-D) — the
 *  stock-overview row itself carries neither `parentProductId` nor a variant
 *  count, so the "Assign to variants" row action is gated off a side
 *  `useProducts({ includeVariants: true })` fetch instead of widening
 *  `/inventory/overview`. */
interface VariantInfo {
  parentProductId: string | null;
  hasVariants: boolean;
}

interface ForecastItem {
  productId: string;
  name: string;
  currentStock: number;
  avgDailySales: number;
  daysRemaining: number | null;
  reorderPoint: number | null;
  reorderQty: number | null;
  needsReorder: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysRemainingBadge(days: number | null) {
  if (days === null) return <span className="text-navy/70 text-xs">N/A</span>;
  const cls =
    days <= 7
      ? "bg-red-100 text-red-700"
      : days <= 30
        ? "bg-yellow-100 text-yellow-700"
        : "bg-green-100 text-green-700";
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", cls)}>{days} days</span>
  );
}

// ─── Quick Restock Modal ──────────────────────────────────────────────────────

function QuickRestockModal({
  suppliers,
  products,
  onClose,
}: {
  suppliers: Supplier[];
  products: {
    id: string;
    name: string;
    sku?: string;
    unit: string;
    currentStock: number;
    unitsPerBox?: number | null;
  }[];
  onClose: () => void;
}) {
  const restock = useRecordPurchase();
  const [form, setForm] = React.useState({
    productId: "",
    supplierId: "",
    quantity: "",
    boxes: "",
    pieces: "",
    unitCost: "",
    reference: "",
    notes: "",
    backdate: false,
    effectiveDate: "",
  });

  const selectedProduct = products.find((p) => p.id === form.productId);
  const decimalQty = selectedProduct ? isDecimalUnit(selectedProduct.unit) : true;
  // Boxed products (unitsPerBox > 1) collect boxes + loose pieces instead of a
  // single ambiguous quantity — the root cause of the stock-corruption bug was
  // an operator typing a box count into a field the server read as pieces.
  const unitsPerBox = Number(selectedProduct?.unitsPerBox ?? 0);
  const isBoxed = unitsPerBox > 1;

  // Scan-to-pick: USB wedge (listens on the picker's search input) or webcam.
  const pickerInputRef = React.useRef<HTMLInputElement | null>(null);
  const qtyInputRef = React.useRef<HTMLInputElement | null>(null);
  const [scanLoading, setScanLoading] = React.useState(false);
  const { toast: scanToast } = useToast();
  const handleScan = async (code: string) => {
    setScanLoading(true);
    try {
      const result = await resolveProductByCode(code);
      if (result.archived) {
        // F30 / R5: restocking a retired product would post stock movements
        // against something the tenant has taken out of service. Name it
        // instead of selecting it — and never call it "not found".
        scanToast({
          title: archivedMessage(result.product),
          description: "Reactivate it on the Products page, then restock it.",
          variant: "error",
        });
      } else if (!result.notFound) {
        setForm((f) => ({ ...f, productId: result.product.id }));
        qtyInputRef.current?.focus();
      } else {
        scanToast({
          title: "No product for that code",
          description: "Add it from the Products page first, then restock it.",
          variant: "error",
        });
      }
    } catch {
      scanToast({ title: "Scan lookup failed — try again", variant: "error" });
    } finally {
      setScanLoading(false);
    }
  };

  // Reference combobox state
  const [refSearch, setRefSearch] = React.useState("");
  const [refOpen, setRefOpen] = React.useState(false);
  const refContainerRef = React.useRef<HTMLDivElement>(null);

  const { data: billsData } = useVendorBills({ limit: 50 });
  const { data: posData } = usePurchaseOrders({ limit: 50 });
  const vendorBills: any[] = (billsData as any)?.data ?? [];
  const purchaseOrders: any[] = (posData as any)?.data ?? [];

  const refOptions = [
    ...vendorBills.map((b: any) => ({
      label: `${b.billNumber} — ${b.supplier?.name ?? ""} (${new Date(b.createdAt).toLocaleDateString()})`,
      value: b.billNumber,
      supplierId: b.supplierId,
    })),
    ...purchaseOrders.map((po: any) => ({
      label: `${po.poNumber} — ${po.supplier?.name ?? ""} (PO)`,
      value: po.poNumber,
      supplierId: po.supplierId,
    })),
  ].filter((o) => !refSearch || o.label.toLowerCase().includes(refSearch.toLowerCase()));

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (refContainerRef.current && !refContainerRef.current.contains(e.target as Node)) {
        setRefOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // The picker isn't a native required control — enforce selection here.
    if (!form.productId) {
      scanToast({ title: "Pick a product first", variant: "error" });
      return;
    }

    const base = {
      productId: form.productId,
      supplierId: form.supplierId || undefined,
      unitCost: Number(form.unitCost),
      reference: form.reference || undefined,
      notes: form.notes || undefined,
      effectiveDate: form.backdate && form.effectiveDate ? form.effectiveDate : undefined,
    };

    if (isBoxed) {
      const boxes = Math.max(0, Math.trunc(Number(form.boxes) || 0));
      const pieces = Math.max(0, Math.trunc(Number(form.pieces) || 0));
      const totalPieces = normalizeBoxesPieces({ boxes, pieces, unitsPerBox }).qty;
      if (totalPieces <= 0) {
        alert("Enter at least one box or piece to receive");
        return;
      }
      // `boxes`/`pieces` — never `quantity` — for a boxed receive; the API
      // resolves the received piece total from the split and ignores a bare
      // `quantity` when either is present (InventoryService.recordPurchase).
      restock.mutate({ ...base, boxes, pieces }, { onSuccess: onClose });
      return;
    }

    const qty = Number(form.quantity);
    if (!decimalQty && !Number.isInteger(qty)) {
      alert(`Quantity must be a whole number for unit "${selectedProduct?.unit}"`);
      return;
    }
    if (!(qty > 0)) {
      alert("Quantity must be greater than zero");
      return;
    }
    restock.mutate({ ...base, quantity: qty }, { onSuccess: onClose });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Quick Restock</h2>
          <p className="mt-0.5 text-xs text-navy/70">
            For supplier invoices, use{" "}
            {/* Left as a plain <a>: `no-html-link-for-pages` only became app-router-aware in
                @next/eslint-plugin-next 15, so this pre-existing link is newly flagged by the
                Next 15 upgrade. Switching it to <Link /> changes it to a client-side
                navigation — a behavior change that belongs to its own diff, not this
                upgrade. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/vendor-bills" className="text-brand-500 hover:underline">
              Bills &amp; Purchasing
            </a>
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          <div>
            <label className="mb-1 block text-xs text-navy">Supplier</label>
            <SupplierSelect
              value={form.supplierId}
              onChange={(id) => setForm((f) => ({ ...f, supplierId: id }))}
              suppliers={suppliers.filter((s) => s.isActive)}
              placeholder="No supplier"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-navy">Product *</label>
            <div className="flex items-stretch gap-2">
              <SearchableProductPicker
                value={form.productId}
                onChange={(id) => setForm((f) => ({ ...f, productId: id }))}
                products={products}
                placeholder="Type a name or SKU, or scan…"
                className="flex-1"
                inputRef={pickerInputRef}
              />
              <BarcodeScannerButton
                onScan={(code) => void handleScan(code)}
                inputRef={pickerInputRef}
                title="Scan a barcode to pick the product (USB scanner: focus the search box and scan)"
              />
            </div>
            {scanLoading && <p className="mt-1 text-xs text-navy/70">Looking up product…</p>}
            {selectedProduct && (
              <p className="mt-1 text-xs text-navy/70">
                Current stock:{" "}
                {unitsLabel(
                  Number(selectedProduct.currentStock),
                  unitsPerBox,
                  selectedProduct.unit,
                )}
                {!decimalQty && !isBoxed && (
                  <span className="ml-2 text-navy/70">(whole numbers only)</span>
                )}
              </p>
            )}
          </div>

          {isBoxed ? (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-xs text-navy">Boxes *</label>
                <input
                  required={!form.pieces}
                  ref={qtyInputRef}
                  type="number"
                  min={0}
                  step={1}
                  value={form.boxes}
                  onChange={(e) => setForm((f) => ({ ...f, boxes: e.target.value }))}
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-navy">+ Pieces</label>
                <input
                  type="number"
                  min={0}
                  max={unitsPerBox - 1}
                  step={1}
                  value={form.pieces}
                  onChange={(e) => setForm((f) => ({ ...f, pieces: e.target.value }))}
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-navy">Cost per Box ($) *</label>
                <input
                  required
                  type="number"
                  min={0}
                  step={0.0001}
                  value={form.unitCost}
                  onChange={(e) => setForm((f) => ({ ...f, unitCost: e.target.value }))}
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <p className="col-span-3 -mt-1 text-[11px] text-navy/50">
                1 box = {unitsPerBox} {selectedProduct?.unit ?? "units"}
                {(Number(form.boxes) > 0 || Number(form.pieces) > 0) && (
                  <>
                    {" "}
                    ·{" "}
                    <span className="font-medium text-navy/70">
                      {
                        normalizeBoxesPieces({
                          boxes: Number(form.boxes) || 0,
                          pieces: Number(form.pieces) || 0,
                          unitsPerBox,
                        }).qty
                      }{" "}
                      pcs total
                    </span>
                  </>
                )}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-navy">
                  Quantity ({selectedProduct?.unit ?? "units"}) *
                </label>
                <input
                  required
                  ref={qtyInputRef}
                  type="number"
                  min={decimalQty ? 0.001 : 1}
                  step={decimalQty ? 0.001 : 1}
                  inputMode={decimalQty ? "decimal" : "numeric"}
                  value={form.quantity}
                  onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder={decimalQty ? "0.000" : "0"}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-navy">Unit Cost ($) *</label>
                <input
                  required
                  type="number"
                  min={0}
                  step={0.0001}
                  value={form.unitCost}
                  onChange={(e) => setForm((f) => ({ ...f, unitCost: e.target.value }))}
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
          )}

          {/* Reference combobox */}
          <div ref={refContainerRef} className="relative">
            <label className="mb-1 block text-xs text-navy">PO / Invoice Reference</label>
            <input
              type="text"
              value={form.reference}
              onChange={(e) => {
                setForm((f) => ({ ...f, reference: e.target.value }));
                setRefSearch(e.target.value);
              }}
              onFocus={() => setRefOpen(true)}
              placeholder="Select or type reference…"
              autoComplete="off"
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {refOpen && refOptions.length > 0 && (
              <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-dropdown">
                <ul className="max-h-40 overflow-y-auto py-1">
                  {refOptions.map((opt) => (
                    <li key={opt.value}>
                      <button
                        type="button"
                        onMouseDown={() => {
                          setForm((f) => ({
                            ...f,
                            reference: opt.value,
                            supplierId: opt.supplierId || f.supplierId,
                          }));
                          setRefSearch(opt.value);
                          setRefOpen(false);
                        }}
                        className="w-full px-3 py-2 text-left text-xs hover:bg-brand-50 text-navy"
                      >
                        {opt.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs text-navy">Notes</label>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="w-full resize-none rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-navy/70">
            <input
              type="checkbox"
              checked={form.backdate}
              onChange={(e) => setForm((f) => ({ ...f, backdate: e.target.checked }))}
            />
            Backdate this entry
          </label>
          {form.backdate && (
            <input
              type="date"
              value={form.effectiveDate}
              onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" loading={restock.isPending}>
              Record Restock
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Stock Table (search + sort) ──────────────────────────────────────────────

/**
 * Stock-tab table extracted into its own component so the sort hook + memoised
 * filter live in a single place. Sort is hover-revealed per the shared
 * convention — the chevron only appears on header hover or when the column is
 * the active sort.
 */
function StockTable({
  stockItems,
  stockSearch,
  missingCostOnly,
  sectionFilter,
  sectionNameById,
  setAdjustPreselectId,
  setShowAdjustModal,
  onSetCost,
  variantInfoById,
  onAssignToVariants,
  scrollToId,
  onScrolled,
}: {
  stockItems: StockItem[];
  stockSearch: string;
  /** Show only products with no cost basis (toggled from the valuation card chip) */
  missingCostOnly: boolean;
  /** Regulated-section filter: "" (all) | "any" | "none" | <sectionId> */
  sectionFilter: string;
  sectionNameById: Map<string, string>;
  setAdjustPreselectId: (id: string | undefined) => void;
  setShowAdjustModal: (v: boolean) => void;
  onSetCost: (item: StockItem) => void;
  /** Parent/variant lookup (PR-D) — keyed by product id; a row's "Assign to
   *  variants" action only renders when the entry exists, has no
   *  `parentProductId`, and `hasVariants`. */
  variantInfoById: Map<string, VariantInfo>;
  onAssignToVariants: (item: StockItem) => void;
  /** Product id to scroll to + briefly highlight (set when a search suggestion
   *  is picked). Left unset while it's not found — e.g. a filter still hides
   *  the row on this render — so the effect retries once `sorted` changes
   *  (the caller clears any filter that would hide it). */
  scrollToId?: string | null;
  /** Called once the target row has actually been found and scrolled to, so
   *  the caller can clear `scrollToId`. */
  onScrolled?: () => void;
}) {
  // 1) Filter by search first so sort only operates on visible rows.
  const filtered = React.useMemo(() => {
    const q = stockSearch.trim().toLowerCase();
    let rows = stockItems;
    if (missingCostOnly) rows = rows.filter((i) => i.averageCost == null);
    if (sectionFilter === "any") rows = rows.filter((i) => i.trackedCategoryId != null);
    else if (sectionFilter === "none") rows = rows.filter((i) => i.trackedCategoryId == null);
    else if (sectionFilter) rows = rows.filter((i) => i.trackedCategoryId === sectionFilter);
    if (!q) return rows;
    return rows.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        (i.sku ?? "").toLowerCase().includes(q) ||
        (i.category ?? "").toLowerCase().includes(q),
    );
  }, [stockItems, stockSearch, missingCostOnly, sectionFilter]);

  // 2) Sort. Numeric columns get explicit comparators so "100" sorts after
  // "20" (string compare would put it first).
  const { sorted, sortKey, sortDir, requestSort } = useSortableData(filtered, {
    defaultKey: "name",
    defaultDir: "asc",
    comparators: {
      currentStock: (a, b) => Number(a.currentStock) - Number(b.currentStock),
      unitsPerBox: (a, b) => (a.unitsPerBox ?? -1) - (b.unitsPerBox ?? -1),
      averageCost: (a, b) => Number(a.averageCost ?? 0) - Number(b.averageCost ?? 0),
      totalValue: (a, b) => Number(a.totalValue ?? 0) - Number(b.totalValue ?? 0),
    },
  });

  // 3) Scroll-to + brief highlight support for a picked search suggestion.
  // `scrollToId` may not resolve to a visible row on the render it's set on
  // (a filter can still be clearing) — the effect just no-ops and retries the
  // next time `sorted` changes, rather than giving up.
  const rowRefs = React.useRef<Map<string, HTMLTableRowElement>>(new Map());
  const [flashId, setFlashId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!scrollToId) return;
    const el = rowRefs.current.get(scrollToId);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashId(scrollToId);
    onScrolled?.();
  }, [scrollToId, sorted, onScrolled]);

  React.useEffect(() => {
    if (!flashId) return;
    const handle = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(handle);
  }, [flashId]);

  if (filtered.length === 0) {
    const q = stockSearch.trim();
    return (
      <div className="bg-white py-10 text-center text-navy/70">
        {q
          ? `No products match "${q}"`
          : missingCostOnly
            ? "Every product has a cost basis — nothing to fix here."
            : "No products found."}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
          <tr>
            <SortableTh
              name="name"
              current={sortKey}
              dir={sortDir}
              onSort={requestSort}
              className="px-4 py-3 font-medium"
            >
              Product
            </SortableTh>
            <SortableTh
              name="sku"
              current={sortKey}
              dir={sortDir}
              onSort={requestSort}
              className="px-4 py-3 font-medium"
            >
              SKU
            </SortableTh>
            <SortableTh
              name="category"
              current={sortKey}
              dir={sortDir}
              onSort={requestSort}
              className="px-4 py-3 font-medium"
            >
              Category
            </SortableTh>
            <SortableTh
              name="currentStock"
              current={sortKey}
              dir={sortDir}
              onSort={requestSort}
              className="px-4 py-3 font-medium"
            >
              Current Stock
            </SortableTh>
            <SortableTh
              name="unitsPerBox"
              current={sortKey}
              dir={sortDir}
              onSort={requestSort}
              className="px-4 py-3 font-medium"
            >
              Per Box
            </SortableTh>
            <SortableTh
              name="averageCost"
              current={sortKey}
              dir={sortDir}
              onSort={requestSort}
              className="px-4 py-3 font-medium"
            >
              <span className="inline-flex items-center gap-1">
                Unit Cost
                <span title="Shows standard cost for STANDARD-costing products, or weighted average cost for AVCO/FIFO/LIFO. Updates automatically when vendor bills are received.">
                  <Info className="h-3 w-3 text-navy/30 cursor-help" />
                </span>
              </span>
            </SortableTh>
            <SortableTh
              name="totalValue"
              current={sortKey}
              dir={sortDir}
              onSort={requestSort}
              className="px-4 py-3 font-medium"
            >
              Total Value
            </SortableTh>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {sorted.map((item) => (
            <tr
              key={item.id}
              ref={(el) => {
                if (el) rowRefs.current.set(item.id, el);
                else rowRefs.current.delete(item.id);
              }}
              className={cn(
                "group transition-colors hover:bg-surface-raised/50",
                item.currentStock <= 0 && "bg-danger-bg/30",
                flashId === item.id && "bg-brand-50 hover:bg-brand-50",
              )}
            >
              <td className="px-4 py-3 font-medium text-navy">
                <span className="inline-flex items-center gap-1.5">
                  {item.name}
                  {item.trackedCategoryId && (
                    <span
                      className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700"
                      title={sectionNameById.get(item.trackedCategoryId) ?? "Regulated type"}
                    >
                      {sectionNameById.get(item.trackedCategoryId) ?? "Type"}
                    </span>
                  )}
                </span>
              </td>
              <td className="px-4 py-3 font-mono text-navy">{item.sku ?? "—"}</td>
              <td className="px-4 py-3 text-navy/70">{item.category ?? "—"}</td>
              <td className="px-4 py-3">
                <span
                  className={cn(
                    "font-medium",
                    item.currentStock <= 0
                      ? "text-danger"
                      : item.currentStock <= 5
                        ? "text-warning"
                        : "text-navy",
                  )}
                >
                  {/* currentStock is stored in PIECES system-wide, so for a BOXED product
                      it must never be rendered next to `item.unit` (a box/case noun) —
                      `unitsLabel` shows the piece count plus a parenthetical box
                      breakdown, and keeps the product's own unit noun when unboxed. */}
                  {unitsLabel(Number(item.currentStock), item.unitsPerBox, item.unit)}
                </span>
              </td>
              <td className="px-4 py-3 text-navy/70">
                {item.unitsPerBox != null ? item.unitsPerBox : "—"}
              </td>
              <td className="px-4 py-3 text-navy/70">
                {item.averageCost != null ? (
                  formatMoney(item.averageCost)
                ) : (
                  <button
                    type="button"
                    onClick={() => onSetCost(item)}
                    title="No cost basis recorded — click to set one"
                    className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 transition-colors hover:bg-amber-200"
                  >
                    No cost set
                  </button>
                )}
              </td>
              <td className="px-4 py-3 text-navy/70">
                {item.totalValue != null ? formatMoney(item.totalValue) : "—"}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => onSetCost(item)}
                    className="text-xs font-medium text-brand-600 transition-colors hover:underline"
                  >
                    Set cost
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAdjustPreselectId(item.id);
                      setShowAdjustModal(true);
                    }}
                    className="text-xs font-medium text-brand-600 transition-colors hover:underline"
                  >
                    Adjust
                  </button>
                  {(() => {
                    const info = variantInfoById.get(item.id);
                    if (!info || info.parentProductId || !info.hasVariants) return null;
                    return (
                      <button
                        type="button"
                        onClick={() => onAssignToVariants(item)}
                        className="text-xs font-medium text-brand-600 transition-colors hover:underline"
                      >
                        Assign to variants
                      </button>
                    );
                  })()}
                  <Link
                    href={`/inventory/movements?product=${item.id}`}
                    className="text-xs text-brand-500 hover:underline"
                  >
                    Movements
                  </Link>
                  <Link
                    href={`/products/${item.id}`}
                    className="text-xs text-brand-500 hover:underline"
                  >
                    Open product
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Adjust Stock Modal ───────────────────────────────────────────────────────

function AdjustStockModal({
  products,
  defaultProductId,
  onClose,
}: {
  products: {
    id: string;
    name: string;
    sku?: string;
    unit: string;
    currentStock: number;
    unitsPerBox?: number | null;
  }[];
  /** Pre-select a product when opened from an inline "Adjust" row action */
  defaultProductId?: string;
  onClose: () => void;
}) {
  const recordAdjustment = useRecordAdjustment();
  const [form, setForm] = React.useState({
    productId: defaultProductId ?? "",
    quantity: "",
    notes: "",
    reference: "",
    backdate: false,
    effectiveDate: "",
  });
  const [productSearch, setProductSearch] = React.useState("");

  // ── Barcode scan support ────────────────────────────────────────────────────
  const barcodeInputRef = React.useRef<HTMLInputElement>(null);
  const barcodeScanHandlerRef = React.useRef<(code: string) => void>(() => {});
  barcodeScanHandlerRef.current = (code: string) => {
    const match = products.find((p) => (p.sku ?? "").toLowerCase() === code.toLowerCase());
    if (match) {
      setForm((f) => ({ ...f, productId: match.id }));
      setProductSearch("");
    }
  };
  React.useEffect(() => {
    const input = barcodeInputRef.current;
    if (!input) return;
    let lastKeyTime = 0;
    let sequence = "";
    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      if (e.key === "Enter") {
        e.preventDefault(); // never submit the form from the search field
        if (sequence.length >= 6 && now - lastKeyTime < 150) {
          barcodeScanHandlerRef.current(sequence);
          sequence = "";
        }
        return;
      }
      if (e.key.length === 1) {
        sequence = now - lastKeyTime > 200 ? e.key : sequence + e.key;
        lastKeyTime = now;
      }
    };
    input.addEventListener("keydown", handleKeyDown);
    return () => input.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredProducts = productSearch.trim()
    ? products.filter(
        (p) =>
          p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
          (p.sku ?? "").toLowerCase().includes(productSearch.toLowerCase()),
      )
    : products;

  const selectedProduct = products.find((p) => p.id === form.productId);
  const qty = Number(form.quantity);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    recordAdjustment.mutate(
      {
        productId: form.productId,
        quantity: qty,
        notes: form.notes || undefined,
        reference: form.reference || undefined,
        effectiveDate: form.backdate && form.effectiveDate ? form.effectiveDate : undefined,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Adjust Stock</h2>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          <div>
            <label className="mb-1 block text-xs text-navy">Product *</label>
            <input
              ref={barcodeInputRef}
              type="text"
              value={
                selectedProduct && !productSearch
                  ? `${selectedProduct.name}${selectedProduct.sku ? ` (${selectedProduct.sku})` : ""}`
                  : productSearch
              }
              onChange={(e) => {
                setProductSearch(e.target.value);
                if (form.productId) setForm((f) => ({ ...f, productId: "" }));
              }}
              placeholder="Type name or SKU, or scan barcode…"
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {productSearch && !form.productId && (
              <div className="mt-1 max-h-48 overflow-y-auto rounded border border-surface-border bg-white shadow-sm">
                {filteredProducts.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-navy/70">
                    No products match &quot;{productSearch}&quot;
                  </p>
                ) : (
                  filteredProducts.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setForm((f) => ({ ...f, productId: p.id }));
                        setProductSearch("");
                      }}
                      className="block w-full cursor-pointer px-3 py-2 text-left text-sm text-navy hover:bg-surface-raised"
                    >
                      {p.name}
                      {p.sku ? <span className="text-navy/70"> ({p.sku})</span> : null}
                    </button>
                  ))
                )}
              </div>
            )}
            {!form.productId && !productSearch && (
              <p className="mt-1 text-xs text-navy/70">Type to search products</p>
            )}
            {selectedProduct && (
              <p className="mt-1 text-xs text-navy/70">
                {/* Stock is stored in PIECES — a boxed product must never be labelled
                    with `product.unit` (the SELLING unit noun), or the operator adjusts
                    in cases; `unitsLabel` keeps that noun only for unboxed products. */}
                Current stock:{" "}
                {unitsLabel(
                  selectedProduct.currentStock,
                  selectedProduct.unitsPerBox,
                  selectedProduct.unit,
                )}
                {form.quantity !== "" && !isNaN(qty) && (
                  <>
                    {" "}
                    →{" "}
                    <strong>
                      {unitsLabel(
                        Number((selectedProduct.currentStock + qty).toFixed(2)),
                        selectedProduct.unitsPerBox,
                        selectedProduct.unit,
                      )}
                    </strong>
                  </>
                )}
                {" · "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setForm((f) => ({ ...f, productId: "" }))}
                >
                  change
                </button>
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs text-navy">
              Quantity change (positive to add, negative to remove) *
            </label>
            <input
              required
              type="number"
              step={0.001}
              value={form.quantity}
              onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-navy">Reference</label>
            <input
              type="text"
              value={form.reference}
              onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-navy">Notes</label>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="w-full resize-none rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-navy/70">
            <input
              type="checkbox"
              checked={form.backdate}
              onChange={(e) => setForm((f) => ({ ...f, backdate: e.target.checked }))}
            />
            Backdate this entry
          </label>
          {form.backdate && (
            <input
              type="date"
              value={form.effectiveDate}
              onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" disabled={!form.productId} loading={recordAdjustment.isPending}>
              Save Adjustment
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Create Supplier Modal ────────────────────────────────────────────────────

function CreateSupplierModal({ onClose }: { onClose: () => void }) {
  const createSupplier = useCreateSupplier();
  const [form, setForm] = React.useState({
    name: "",
    contactName: "",
    phone: "",
    email: "",
    notes: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createSupplier.mutate(
      {
        name: form.name,
        contactName: form.contactName || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        notes: form.notes || undefined,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Add Supplier</h2>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          {[
            { key: "name", label: "Company Name *", required: true },
            { key: "contactName", label: "Contact Name" },
            { key: "phone", label: "Phone" },
            { key: "email", label: "Email", type: "email" },
          ].map(({ key, label, required, type }) => (
            <div key={key}>
              <label className="mb-1 block text-xs text-navy">{label}</label>
              <input
                required={required}
                type={type ?? "text"}
                value={(form as any)[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          ))}
          <div>
            <label className="mb-1 block text-xs text-navy">Notes</label>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="w-full resize-none rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" loading={createSupplier.isPending}>
              Add Supplier
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Reorder Settings Modal ───────────────────────────────────────────────────

function ReorderSettingsModal({ item, onClose }: { item: ForecastItem; onClose: () => void }) {
  const updateSettings = useUpdateReorderSettings();
  const { toast } = useToast();
  const [reorderPoint, setReorderPoint] = React.useState(String(item.reorderPoint ?? ""));
  const [reorderQty, setReorderQty] = React.useState(String(item.reorderQty ?? ""));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateSettings.mutate(
      {
        productId: item.productId,
        reorderPoint: Number(reorderPoint),
        reorderQty: Number(reorderQty),
      },
      {
        onSuccess: () => {
          toast({ title: "Reorder settings saved.", variant: "success" });
          onClose();
        },
        onError: () => toast({ title: "Failed to save settings.", variant: "error" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Reorder Settings</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <p className="text-sm text-navy/70">{item.name}</p>
          <div>
            <label className="mb-1 block text-xs text-navy">Reorder Point (trigger qty)</label>
            <input
              required
              type="number"
              min={0}
              step={0.001}
              value={reorderPoint}
              onChange={(e) => setReorderPoint(e.target.value)}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-navy">Reorder Qty (amount to order)</label>
            <input
              required
              type="number"
              min={0}
              step={0.001}
              value={reorderQty}
              onChange={(e) => setReorderQty(e.target.value)}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button type="submit" loading={updateSettings.isPending}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Inline editable cell ─────────────────────────────────────────────────────

function InlineNumberEdit({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (v: number) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [inputVal, setInputVal] = React.useState(value != null ? String(value) : "");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const n = parseFloat(inputVal);
    if (!isNaN(n) && n >= 0) onSave(n);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={0}
        step={0.01}
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-20 rounded border border-brand-400 px-2 py-0.5 text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
    );
  }

  return (
    <button
      onClick={() => {
        setInputVal(value != null ? String(value) : "");
        setEditing(true);
      }}
      title="Click to edit"
      className="group flex items-center gap-1 rounded px-1 py-0.5 text-sm text-navy/70 hover:bg-surface-raised"
    >
      {value != null ? value : <span className="text-navy/30">—</span>}
      <span className="hidden text-[10px] text-navy/30 group-hover:inline">✎</span>
    </button>
  );
}

// ─── Forecasting Tab ──────────────────────────────────────────────────────────

function ForecastingTab({
  suppliers,
  products,
}: {
  suppliers: Supplier[];
  products: { id: string; name: string; sku?: string; unitsPerBox?: number | null }[];
}) {
  const { data: forecastData, isLoading } = useForecasting();
  const updateSettings = useUpdateReorderSettings();
  const { toast } = useToast();
  const items: ForecastItem[] = forecastData ?? [];

  const [createPOItem, setCreatePOItem] = React.useState<ForecastItem | null>(null);

  const handleSaveField = (
    item: ForecastItem,
    field: "reorderPoint" | "reorderQty",
    value: number,
  ) => {
    updateSettings.mutate(
      {
        productId: item.productId,
        reorderPoint: field === "reorderPoint" ? value : (item.reorderPoint ?? 0),
        reorderQty: field === "reorderQty" ? value : (item.reorderQty ?? 0),
      },
      {
        onSuccess: () => toast({ title: "Saved", variant: "success" }),
        onError: () => toast({ title: "Failed to save", variant: "error" }),
      },
    );
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-navy">Demand Forecasting</h2>
        {items.filter((i) => i.needsReorder).length > 0 && (
          <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
            {items.filter((i) => i.needsReorder).length} items need reorder
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-raised" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-surface-border">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
              <tr>
                {[
                  "Product",
                  "Current Stock",
                  "Avg Daily Sales",
                  "Days Remaining",
                  "Reorder Point",
                  "Reorder Qty",
                  "Status",
                  "Actions",
                ].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {items.map((item) => (
                <tr
                  key={item.productId}
                  className={cn(
                    "transition-colors hover:bg-surface-raised/40",
                    item.needsReorder && "bg-red-50/60",
                  )}
                >
                  <td className="px-4 py-3 font-medium text-navy">{item.name}</td>
                  <td className="px-4 py-3 text-navy/70">{Number(item.currentStock).toFixed(2)}</td>
                  <td className="px-4 py-3 text-navy/70">
                    {item.avgDailySales != null ? Number(item.avgDailySales).toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-3">{daysRemainingBadge(item.daysRemaining)}</td>
                  <td className="px-4 py-3">
                    <InlineNumberEdit
                      value={item.reorderPoint}
                      onSave={(v) => handleSaveField(item, "reorderPoint", v)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <InlineNumberEdit
                      value={item.reorderQty}
                      onSave={(v) => handleSaveField(item, "reorderQty", v)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {item.needsReorder ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
                        Reorder Now
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
                        OK
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {item.needsReorder && (
                      <button
                        onClick={() => setCreatePOItem(item)}
                        className="rounded px-2 py-1 text-xs text-white bg-brand-500 hover:bg-brand-600"
                      >
                        Create PO
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-navy/70">
                    No forecasting data available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {createPOItem && (
        <CreatePOModal
          suppliers={suppliers}
          products={products}
          onClose={() => setCreatePOItem(null)}
        />
      )}
    </>
  );
}

// ─── Set Cost Basis Modal ─────────────────────────────────────────────────────

// ─── Bulk Set Costs Modal (products with no cost basis) ───────────────────────

function BulkSetCostModal({
  products,
  onClose,
}: {
  products: { id: string; name: string }[];
  onClose: () => void;
}) {
  const bulkSet = useBulkSetCostBasis();
  const { toast } = useToast();
  const [costs, setCosts] = React.useState<Record<string, string>>({});

  const filledCount = Object.values(costs).filter((v) => v.trim() !== "").length;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const items = products
      .filter((p) => (costs[p.id] ?? "").trim() !== "")
      .map((p) => ({ productId: p.id, unitCost: Number(costs[p.id]) }));
    if (items.length === 0) return;
    bulkSet.mutate(
      { items, notes: "Bulk cost basis entry" },
      {
        onSuccess: (result: { updated: number }) => {
          toast({
            title: "Cost bases set",
            description: `${result.updated} product${result.updated === 1 ? "" : "s"} updated.`,
            variant: "success",
          });
          onClose();
        },
        onError: () =>
          toast({
            title: "Failed to set costs",
            description: "Please try again.",
            variant: "error",
          }),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Set missing cost bases"
      description="These products have no purchase history and no cost — enter what a unit costs you. Leave rows blank to skip them."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
          {products.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-sm text-navy" title={p.name}>
                {p.name}
              </span>
              <div className="relative w-32 shrink-0">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-navy/50">
                  $
                </span>
                <input
                  type="number"
                  min={0}
                  step={0.0001}
                  value={costs[p.id] ?? ""}
                  onChange={(e) => setCosts((c) => ({ ...c, [p.id]: e.target.value }))}
                  className="w-full rounded border border-surface-border py-1.5 pl-6 pr-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="0.00"
                />
              </div>
            </div>
          ))}
          {products.length === 0 && (
            <p className="py-6 text-center text-sm text-navy/70">
              Every product already has a cost basis.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-surface-border pt-3">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={bulkSet.isPending} disabled={filledCount === 0}>
            Set {filledCount > 0 ? `${filledCount} ` : ""}Cost{filledCount === 1 ? "" : "s"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Recompute Costs Modal (dry-run preview → apply) ──────────────────────────
//
// B562 (interim mitigation, owner-approved): every button that opened this modal
// was removed below — recompute-costs is blind to raw order decrements and can
// silently rewrite a tenant's whole inventory valuation while destroying the
// `stockAfter` evidence needed to detect it (see the comment on
// InventoryController.recomputeCosts). The component and its state are left in
// place, unreachable from the UI, until B562's root cause is fixed.

function RecomputeModal({ onClose }: { onClose: () => void }) {
  const recompute = useRecomputeCosts();
  const { toast } = useToast();
  const [preview, setPreview] = React.useState<RecomputeCostsResult | null>(null);

  // Dry-run on open so the operator always reviews before writing
  React.useEffect(() => {
    recompute.mutate(
      { dryRun: true },
      {
        onSuccess: (result) => setPreview(result),
        onError: () =>
          toast({
            title: "Recompute preview failed",
            description: "Please try again.",
            variant: "error",
          }),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changed = (preview?.results ?? []).filter(
    (r) => (r.oldAvgCost ?? null) !== (r.newAvgCost ?? null),
  );

  const handleApply = () => {
    recompute.mutate(
      { dryRun: false },
      {
        onSuccess: (result) => {
          toast({
            title: "Costs recomputed",
            description: `${result.updated} product${result.updated === 1 ? "" : "s"} rebuilt from purchase history.`,
            variant: "success",
          });
          onClose();
        },
        onError: () =>
          toast({ title: "Recompute failed", description: "Please try again.", variant: "error" }),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Recompute costs from history"
      description="Replays every product's purchase movements to rebuild its average cost and repair historical snapshots. Preview below — nothing is written until you apply."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={recompute.isPending}>
            Cancel
          </Button>
          <Button onClick={handleApply} loading={recompute.isPending} disabled={!preview}>
            Apply Recompute
          </Button>
        </>
      }
    >
      {!preview ? (
        <p className="py-6 text-center text-sm text-navy/70">Computing preview…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-surface-raised p-2">
              <p className="text-lg font-bold text-navy">{preview.processed}</p>
              <p className="text-[11px] text-navy/70">products scanned</p>
            </div>
            <div className="rounded-lg bg-surface-raised p-2">
              <p className="text-lg font-bold text-navy">{changed.length}</p>
              <p className="text-[11px] text-navy/70">costs will change</p>
            </div>
            <div className="rounded-lg bg-amber-50 p-2">
              <p className="text-lg font-bold text-amber-800">{preview.noHistory.length}</p>
              <p className="text-[11px] text-amber-800/80">no purchase history</p>
            </div>
          </div>

          {changed.length > 0 && (
            <div className="max-h-56 overflow-y-auto rounded-lg border border-surface-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-raised text-navy/70">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Current</th>
                    <th className="px-3 py-2 text-right font-medium">Recomputed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {changed.map((r) => (
                    <tr key={r.productId}>
                      <td className="max-w-[180px] truncate px-3 py-1.5 text-navy" title={r.name}>
                        {r.name}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-navy/70">
                        {r.oldAvgCost != null ? `$${r.oldAvgCost.toFixed(4)}` : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums text-navy">
                        {r.newAvgCost != null ? `$${r.newAvgCost.toFixed(4)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.noHistory.length > 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {preview.noHistory.length} product{preview.noHistory.length === 1 ? " has" : "s have"}{" "}
              no recorded purchases — recompute leaves them untouched. Use{" "}
              <span className="font-semibold">Set Costs</span> to enter their cost basis manually.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Inventory");
  }, [setTitle]);

  // Deep-linkable to the Stock Count tab — `?tab=count` (and `?amend=<id>`,
  // which implies it) land on "count" instead of the default "stock". Read
  // once on mount; StockCountTab strips `amend` from the URL itself once it's
  // consumed the deep link, so this never needs to react to later changes.
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = React.useState(() =>
    searchParams.get("tab") === "count" || searchParams.get("amend") ? "count" : "stock",
  );

  const { data: stockItems = [], isLoading: stockLoading } = useStockOverview();
  const { data: suppliers = [], isLoading: suppliersLoading } = useSuppliers();
  const { data: productsData } = useProducts({ isActive: true, limit: 0 });
  const products = productsData?.data ?? [];
  // Parent/variant lookup for the Stock tab's "Assign to variants" row action
  // (PR-D) — a separate fetch (not the active-only `products` above, and not
  // `/inventory/overview`, which selects neither field) since it needs every
  // product's `parentProductId` plus `includeVariants` to know which rows are
  // splittable generics.
  const { data: variantProductsData } = useProducts({ includeVariants: true, limit: 0 });
  const variantInfoById = React.useMemo(() => {
    const map = new Map<string, VariantInfo>();
    for (const p of variantProductsData?.data ?? []) {
      map.set(p.id, {
        parentProductId: p.parentProductId ?? null,
        hasVariants: (p.variants?.length ?? 0) > 0,
      });
    }
    return map;
  }, [variantProductsData]);

  const [showRestockModal, setShowPurchaseModal] = React.useState(false);
  const [showAdjustModal, setShowAdjustModal] = React.useState(false);
  // When set, the next AdjustStockModal opens with this product pre-selected.
  // Cleared after the modal closes so the next "Adjust Stock" header click
  // opens with no pre-selection.
  const [adjustPreselectId, setAdjustPreselectId] = React.useState<string | undefined>();
  const [showScanModal, setShowScanModal] = React.useState(false);
  // Filtering is client-side, so the raw value drives the table; only the URL
  // mirror is debounced.
  const [stockSearch, setStockSearch] = useUrlSearch();
  // Typeahead state for the Stock-tab search box
  const [stockSuggestOpen, setStockSuggestOpen] = React.useState(false);
  const [stockSuggestHighlight, setStockSuggestHighlight] = React.useState(0);
  const stockSearchContainerRef = React.useRef<HTMLDivElement>(null);
  // Product id to scroll to + briefly highlight in the (already-filtered)
  // StockTable when a search suggestion is picked, instead of force-opening
  // Adjust Stock — the table already offers Set cost / Adjust / Movements.
  const [scrollToProductId, setScrollToProductId] = React.useState<string | null>(null);
  const [showSupplierModal, setShowSupplierModal] = React.useState(false);
  const [showAddProductModal, setShowAddProductModal] = React.useState(false);
  // Cost-basis tooling
  const [costTarget, setCostTarget] = React.useState<StockItem | null>(null);
  // Variant-split modal target (PR-D) — the Stock row's "Assign to variants" action
  const [variantSplitTarget, setVariantSplitTarget] = React.useState<StockItem | null>(null);
  const [showBulkCostModal, setShowBulkCostModal] = React.useState(false);
  const [showRecomputeModal, setShowRecomputeModal] = React.useState(false);
  const [missingCostOnly, setMissingCostOnly] = React.useState(false);
  const [urlFilters, setUrlFilter] = useUrlFilters({ section: "" });
  const sectionFilter = urlFilters.section;

  const { data: trackedCategories } = useTrackedCategories();
  const sectionNameById = React.useMemo(
    () => new Map((trackedCategories ?? []).map((c) => [c.id, c.name])),
    [trackedCategories],
  );
  const activeSections = React.useMemo(
    () => (trackedCategories ?? []).filter((c) => c.active),
    [trackedCategories],
  );

  const { data: valuation } = useInventoryValuation();

  const totalInventoryValue =
    valuation?.totalValue ??
    (stockItems as StockItem[]).reduce((sum, item) => sum + (item.totalValue ?? 0), 0);
  const missingCostCount = valuation?.missingCostCount ?? 0;
  const outOfStockCount = (stockItems as StockItem[]).filter((i) => i.currentStock <= 0).length;

  // Close the typeahead when clicking outside, and reset the highlight whenever
  // the query changes so the first match is always preselected.
  React.useEffect(() => {
    if (!stockSuggestOpen) return;
    const onClick = (e: MouseEvent) => {
      if (
        stockSearchContainerRef.current &&
        !stockSearchContainerRef.current.contains(e.target as Node)
      ) {
        setStockSuggestOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [stockSuggestOpen]);
  React.useEffect(() => setStockSuggestHighlight(0), [stockSearch]);

  // Filtered suggestions for the typeahead dropdown. Capped at 8 so a long
  // catalog doesn't push the dropdown off-screen — the user can still see
  // every match in the table beneath. Match SKU first so a barcode scan
  // surfaces the exact-SKU result above name-substring matches.
  const stockSuggestions = React.useMemo(() => {
    const q = stockSearch.trim().toLowerCase();
    if (!q) return [] as StockItem[];
    const rows = stockItems as StockItem[];
    const skuExact: StockItem[] = [];
    const skuPrefix: StockItem[] = [];
    const nameMatch: StockItem[] = [];
    const other: StockItem[] = [];
    for (const r of rows) {
      const sku = (r.sku ?? "").toLowerCase();
      const name = r.name.toLowerCase();
      const cat = (r.category ?? "").toLowerCase();
      if (sku === q) skuExact.push(r);
      else if (sku.startsWith(q)) skuPrefix.push(r);
      else if (name.includes(q)) nameMatch.push(r);
      else if (sku.includes(q) || cat.includes(q)) other.push(r);
    }
    return [...skuExact, ...skuPrefix, ...nameMatch, ...other].slice(0, 8);
  }, [stockSearch, stockItems]);

  // Picking a suggestion scrolls to and highlights its row in the table
  // instead of opening a modal. Clear only the filter(s) that would actually
  // hide the picked row — missingCostOnly / the regulated-section tab — so
  // the row is guaranteed visible without discarding an unrelated filter.
  const pickSuggestion = React.useCallback(
    (id: string) => {
      const target = (stockItems as StockItem[]).find((i) => i.id === id);
      if (target) {
        if (missingCostOnly && target.averageCost != null) setMissingCostOnly(false);
        const hiddenBySection =
          sectionFilter === "any"
            ? target.trackedCategoryId == null
            : sectionFilter === "none"
              ? target.trackedCategoryId != null
              : sectionFilter
                ? target.trackedCategoryId !== sectionFilter
                : false;
        if (hiddenBySection) setUrlFilter("section", "");
      }
      setStockSuggestOpen(false);
      setScrollToProductId(id);
    },
    [stockItems, missingCostOnly, sectionFilter, setUrlFilter],
  );
  const clearScrollTarget = React.useCallback(() => setScrollToProductId(null), []);

  const tabs = [
    { value: "stock", label: "Stock" },
    { value: "count", label: "Stock Count" },
    { value: "suppliers", label: "Suppliers" },
    { value: "purchase-orders", label: "Purchase Orders" },
    { value: "forecasting", label: "Forecasting" },
  ];

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Inventory"
        subtitle="Stock levels, cost basis, purchasing, and forecasting across your catalog."
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-surface-border bg-white p-4 shadow-card">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
            Total Products
          </p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-navy">
            {(stockItems as StockItem[]).length}
          </p>
          <p className="text-xs text-navy/70">tracked SKUs</p>
        </div>

        <div
          className={cn(
            "rounded-lg border border-surface-border bg-white p-4 shadow-card",
            missingCostCount > 0 && "border-warning/40 ring-2 ring-warning/10",
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
              Stock Value (cost)
            </p>
            {totalInventoryValue === 0 && (
              <span
                title="Value is calculated from average cost per unit. Record purchase receipts in the Vendor Bills tab to populate costs."
                className="cursor-help"
              >
                <Info className="h-3.5 w-3.5 text-navy/30" />
              </span>
            )}
          </div>
          <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums tracking-[-0.01em] text-navy">
            {formatMoney(totalInventoryValue)}
          </p>
          {missingCostCount > 0 ? (
            <button
              type="button"
              onClick={() => setMissingCostOnly((v) => !v)}
              className={cn(
                "mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors",
                missingCostOnly
                  ? "bg-amber-500 text-white hover:bg-amber-600"
                  : "bg-amber-100 text-amber-800 hover:bg-amber-200",
              )}
              title="These products have no cost basis and are excluded from the total — click to filter the table to them"
            >
              {missingCostCount} missing cost{missingCostOnly ? " ✕" : ""}
            </button>
          ) : (
            totalInventoryValue === 0 && (
              <p className="mt-0.5 text-[10px] text-navy/70">
                Based on average cost — record purchases to update
              </p>
            )
          )}
        </div>

        <div
          className={cn(
            "rounded-lg border border-surface-border bg-white p-4 shadow-card",
            outOfStockCount > 0 && "border-danger/40 ring-2 ring-danger/10",
          )}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
            Out of Stock
          </p>
          <p
            className={cn(
              "mt-1.5 text-2xl font-semibold tabular-nums",
              outOfStockCount > 0 ? "text-danger" : "text-navy",
            )}
          >
            {outOfStockCount}
          </p>
          {outOfStockCount > (stockItems as StockItem[]).length * 0.5 ? (
            <p className="text-xs text-navy/70">Stock may need updating after import</p>
          ) : (
            <p className="text-xs text-navy/70">none on hand (or negative)</p>
          )}
        </div>
      </div>

      {/* Import artifact notice */}
      {outOfStockCount > (stockItems as StockItem[]).length * 0.5 && (
        <div className="flex items-start gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
          <p className="text-sm text-brand-700">
            Many products show zero stock because stock quantities were not included in the initial
            import. Use <strong>Quick Restock</strong> or record a purchase receipt to assign stock
            levels.
          </p>
        </div>
      )}

      <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
        <Tabs.List className="flex gap-1 border-b border-surface-border">
          {tabs.map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "-mb-px border-b-2 border-transparent px-4 py-2.5 text-sm font-medium transition-colors",
                "text-navy/70 hover:text-navy",
                "data-[state=active]:border-brand-500 data-[state=active]:text-navy",
              )}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {/* ── Stock tab ── */}
        <Tabs.Content value="stock" className="pt-4">
          {/* Regulated scope tabs — hidden entirely when the tenant has no sections */}
          <RegulatedScopeTabs
            value={sectionFilter}
            onChange={(v) => setUrlFilter("section", v)}
            sections={activeSections.map((s) => ({
              id: s.id,
              name: s.name,
              productCount: s.productCount,
            }))}
            className="mb-2.5"
          />

          <div className="flex flex-wrap items-center gap-3 rounded-t-lg border border-b-0 border-surface-border bg-white px-4 py-3 shadow-card">
            {/* Search — filters the stock table by name, SKU, or category so
                operators can jump to a product before adjusting its stock,
                instead of scrolling a long list. Also surfaces a typeahead
                dropdown with the top 8 matches so the operator can click
                "Adjust" without scrolling the table at all. */}
            <div ref={stockSearchContainerRef} className="relative flex-1 min-w-[220px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-navy/70" />
              <input
                type="search"
                value={stockSearch}
                onChange={(e) => {
                  setStockSearch(e.target.value);
                  setStockSuggestOpen(true);
                }}
                onFocus={() => setStockSuggestOpen(true)}
                onKeyDown={(e) => {
                  if (!stockSuggestOpen && (e.key === "ArrowDown" || e.key === "Enter")) {
                    setStockSuggestOpen(true);
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setStockSuggestHighlight((h) => Math.min(h + 1, stockSuggestions.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setStockSuggestHighlight((h) => Math.max(h - 1, 0));
                  } else if (e.key === "Enter") {
                    const pick = stockSuggestions[stockSuggestHighlight];
                    if (pick) {
                      e.preventDefault();
                      pickSuggestion(pick.id);
                    }
                  } else if (e.key === "Escape") {
                    setStockSuggestOpen(false);
                  }
                }}
                placeholder="Search by name, SKU, or category…"
                className="h-9 w-full rounded-lg border border-surface-border bg-white pl-9 pr-9 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                role="combobox"
                aria-expanded={stockSuggestOpen && stockSuggestions.length > 0}
                aria-autocomplete="list"
              />
              {stockSearch && (
                <button
                  type="button"
                  onClick={() => {
                    setStockSearch("");
                    setStockSuggestOpen(false);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-navy/30 transition-colors hover:bg-surface-raised hover:text-navy"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}

              {/* Typeahead dropdown */}
              {stockSuggestOpen && stockSearch.trim() && (
                <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-lg">
                  {stockSuggestions.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-navy/70">
                      No products match &quot;{stockSearch}&quot;.
                    </p>
                  ) : (
                    <ul role="listbox" className="py-1">
                      {stockSuggestions.map((s, idx) => {
                        const stockColor =
                          s.currentStock <= 0
                            ? "text-danger"
                            : s.currentStock <= 5
                              ? "text-warning"
                              : "text-navy/70";
                        const stockLabel =
                          Number(s.currentStock) % 1 === 0
                            ? Number(s.currentStock).toFixed(0)
                            : Number(s.currentStock).toFixed(2);
                        return (
                          <li
                            key={s.id}
                            role="option"
                            aria-selected={idx === stockSuggestHighlight}
                            onMouseEnter={() => setStockSuggestHighlight(idx)}
                            className={cn(
                              "flex flex-col gap-1.5 px-3 py-2 text-sm transition-colors",
                              idx === stockSuggestHighlight
                                ? "bg-brand-50"
                                : "hover:bg-surface-raised",
                            )}
                          >
                            {/* Primary pick: scrolls to + highlights the row in the
                                table below, instead of force-opening a modal. */}
                            <button
                              type="button"
                              onMouseDown={(e) => {
                                // mousedown so it fires before the input loses focus / closes the menu
                                e.preventDefault();
                                pickSuggestion(s.id);
                              }}
                              className="flex w-full cursor-pointer items-center gap-3 text-left"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium text-navy" title={s.name}>
                                  {s.name}
                                </p>
                                <p className="truncate text-[11px] text-navy/70">
                                  {s.sku ? (
                                    <span className="font-mono">{s.sku}</span>
                                  ) : (
                                    <span className="italic">no SKU</span>
                                  )}
                                  {s.category ? <span> · {s.category}</span> : null}
                                </p>
                              </div>
                              <p
                                className={cn(
                                  "shrink-0 text-xs font-medium tabular-nums",
                                  stockColor,
                                )}
                              >
                                {stockLabel} {s.unit}
                              </p>
                            </button>
                            {/* Same action set as the table row, plus the product link. */}
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-0.5 text-[11px] font-medium">
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  setCostTarget(s);
                                  setStockSuggestOpen(false);
                                }}
                                className="text-brand-600 hover:underline"
                              >
                                Set cost
                              </button>
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  setAdjustPreselectId(s.id);
                                  setShowAdjustModal(true);
                                  setStockSuggestOpen(false);
                                }}
                                className="text-brand-600 hover:underline"
                              >
                                Adjust
                              </button>
                              <Link
                                href={`/inventory/movements?product=${s.id}`}
                                className="text-brand-500 hover:underline"
                                onClick={() => setStockSuggestOpen(false)}
                              >
                                Movements
                              </Link>
                              <Link
                                href={`/products/${s.id}`}
                                className="text-brand-500 hover:underline"
                                onClick={() => setStockSuggestOpen(false)}
                              >
                                Open product
                              </Link>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <p className="text-sm text-navy/70 whitespace-nowrap">
              {(() => {
                const total = (stockItems as StockItem[]).length;
                if (!stockSearch.trim()) return `${total} product${total === 1 ? "" : "s"}`;
                const q = stockSearch.trim().toLowerCase();
                const shown = (stockItems as StockItem[]).filter(
                  (i) =>
                    i.name.toLowerCase().includes(q) ||
                    (i.sku ?? "").toLowerCase().includes(q) ||
                    (i.category ?? "").toLowerCase().includes(q),
                ).length;
                return `${shown} of ${total}`;
              })()}
            </p>
            <div className="flex gap-2">
              {/* B562 (interim mitigation): the dedicated "Recompute" button and the
                  "Costs" button's recompute fallback (used when there were no missing
                  costs) were removed here. recompute-costs is blind to raw order
                  decrements and can silently rewrite a tenant's whole inventory
                  valuation — see the controller comment on
                  InventoryController.recomputeCosts. Only the "Set Costs" path (for
                  products genuinely missing a cost basis) remains reachable. Do not
                  re-add either entry point until B562's root cause is fixed. */}
              {missingCostCount > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<DollarSign className="h-4 w-4" />}
                  onClick={() => setShowBulkCostModal(true)}
                  title={`Set a cost basis for the ${missingCostCount} product(s) without one`}
                >
                  {`Set Costs (${missingCostCount})`}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<SlidersHorizontal className="h-4 w-4" />}
                onClick={() => {
                  setAdjustPreselectId(undefined);
                  setShowAdjustModal(true);
                }}
              >
                Adjust Stock
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => setShowAddProductModal(true)}
              >
                Add Product
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Sparkles className="h-4 w-4" />}
                onClick={() => setShowScanModal(true)}
              >
                Scan Invoice
              </Button>
              <Button
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => setShowPurchaseModal(true)}
              >
                Quick Restock
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-b-lg border border-t-0 border-surface-border bg-white shadow-card">
            {stockLoading ? (
              <div className="space-y-2 p-4">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-raised" />
                ))}
              </div>
            ) : (
              <StockTable
                stockItems={stockItems as StockItem[]}
                stockSearch={stockSearch}
                missingCostOnly={missingCostOnly}
                sectionFilter={sectionFilter}
                sectionNameById={sectionNameById}
                setAdjustPreselectId={setAdjustPreselectId}
                setShowAdjustModal={setShowAdjustModal}
                onSetCost={setCostTarget}
                variantInfoById={variantInfoById}
                onAssignToVariants={setVariantSplitTarget}
                scrollToId={scrollToProductId}
                onScrolled={clearScrollTarget}
              />
            )}
          </div>
        </Tabs.Content>

        {/* ── Stock Count tab ── */}
        <Tabs.Content value="count" className="pt-4">
          <StockCountTab />
        </Tabs.Content>

        {/* ── Suppliers tab ── */}
        <Tabs.Content value="suppliers" className="pt-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-navy/70">{(suppliers as Supplier[]).length} suppliers</p>
            <Button
              size="sm"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setShowSupplierModal(true)}
            >
              Add Supplier
            </Button>
          </div>

          {suppliersLoading ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-raised" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-surface-border">
              <table className="w-full text-sm">
                <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
                  <tr>
                    {["Name", "Contact", "Phone", "Email", "Status"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {(suppliers as Supplier[]).map((s) => (
                    <tr key={s.id} className="transition-colors hover:bg-surface-raised/50">
                      <td className="px-4 py-3 font-medium text-navy">{s.name}</td>
                      <td className="px-4 py-3 text-navy/70">{s.contactName ?? "—"}</td>
                      <td className="px-4 py-3 text-navy/70">{s.phone ?? "—"}</td>
                      <td className="px-4 py-3 text-navy/70">{s.email ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={s.isActive ? "success" : "neutral"}
                          label={s.isActive ? "Active" : "Inactive"}
                        />
                      </td>
                    </tr>
                  ))}
                  {(suppliers as Supplier[]).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-navy/70">
                        No suppliers yet. Add your first supplier.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Content>

        {/* ── Purchase Orders tab ── */}
        <Tabs.Content value="purchase-orders" className="pt-4">
          <PurchaseOrdersTab
            suppliers={suppliers as Supplier[]}
            products={products.map((p: any) => ({
              id: p.id,
              name: p.name,
              sku: p.sku,
              unitsPerBox: p.unitsPerBox ?? null,
            }))}
          />
        </Tabs.Content>

        {/* ── Forecasting tab ── */}
        <Tabs.Content value="forecasting" className="pt-4">
          <ForecastingTab
            suppliers={suppliers as Supplier[]}
            products={products.map((p: any) => ({
              id: p.id,
              name: p.name,
              sku: p.sku,
              unitsPerBox: p.unitsPerBox ?? null,
            }))}
          />
        </Tabs.Content>
      </Tabs.Root>

      {showRestockModal && (
        <QuickRestockModal
          suppliers={suppliers as Supplier[]}
          products={products.map((p: any) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            unit: p.unit,
            currentStock: Number(p.currentStock ?? 0),
            unitsPerBox: p.unitsPerBox ?? null,
          }))}
          onClose={() => setShowPurchaseModal(false)}
        />
      )}
      {showAdjustModal && (
        <AdjustStockModal
          products={products.map((p: any) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            unit: p.unit,
            currentStock: Number(p.currentStock ?? 0),
            unitsPerBox: p.unitsPerBox ?? null,
          }))}
          defaultProductId={adjustPreselectId}
          onClose={() => {
            setShowAdjustModal(false);
            setAdjustPreselectId(undefined);
          }}
        />
      )}
      {showSupplierModal && <CreateSupplierModal onClose={() => setShowSupplierModal(false)} />}
      <InlineCreateProductModal
        isOpen={showAddProductModal}
        onClose={() => setShowAddProductModal(false)}
        onCreated={() => setShowAddProductModal(false)}
      />
      <ScanInvoiceModal
        open={showScanModal}
        onClose={() => setShowScanModal(false)}
        onCreated={() => setShowScanModal(false)}
      />
      {costTarget && <SetCostModal item={costTarget} onClose={() => setCostTarget(null)} />}
      {/* Variant-split modal (PR-D) — same component as the product detail
          page and the vendor-bill line badge. Pool defaults to the parent's
          full `currentStock`. */}
      {variantSplitTarget && (
        <VariantSplitModal
          parent={{
            id: variantSplitTarget.id,
            name: variantSplitTarget.name,
            currentStock: variantSplitTarget.currentStock,
            averageCost: variantSplitTarget.averageCost,
            unitsPerBox: variantSplitTarget.unitsPerBox ?? null,
            costingMethod: variantSplitTarget.costingMethod,
          }}
          onClose={() => setVariantSplitTarget(null)}
          onSuccess={() => setVariantSplitTarget(null)}
        />
      )}
      {showBulkCostModal && (
        <BulkSetCostModal
          products={valuation?.missingCostProducts ?? []}
          onClose={() => setShowBulkCostModal(false)}
        />
      )}
      {showRecomputeModal && <RecomputeModal onClose={() => setShowRecomputeModal(false)} />}
    </div>
  );
}
