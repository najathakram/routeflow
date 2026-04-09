"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import Link from "next/link";
import { Plus, Eye, Send, PackageCheck, X, ChevronDown, ChevronUp, Info } from "lucide-react";
import { Badge, Button, Card, cn, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useStockOverview,
  useSuppliers,
  useRecordPurchase,
  useRecordAdjustment,
  useCreateSupplier,
  useUpdateSupplier,
  usePurchaseOrders,
  usePurchaseOrder,
  useCreatePurchaseOrder,
  useSendPurchaseOrder,
  useReceivePurchaseOrder,
  useClosePurchaseOrder,
  useForecasting,
  useUpdateReorderSettings,
} from "@/lib/api/inventory";
import { useProducts } from "@/lib/api/products";
import { useVendorBills } from "@/lib/api/vendor-bills";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";

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
}

interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  isActive: boolean;
}

type POStatus = "DRAFT" | "SENT" | "PARTIAL" | "RECEIVED" | "CLOSED";

interface POItem {
  id: string;
  productId: string;
  productName: string;
  qty: number;
  unitCost: number;
  receivedQty?: number;
}

interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplier: Supplier;
  status: POStatus;
  items: POItem[];
  total: number;
  expectedDate: string;
  notes?: string;
  createdAt: string;
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

function poStatusBadge(status: POStatus) {
  const map: Record<POStatus, { variant: "neutral" | "info" | "warning" | "success"; label: string }> = {
    DRAFT: { variant: "neutral", label: "Draft" },
    SENT: { variant: "info", label: "Sent" },
    PARTIAL: { variant: "warning", label: "Partial" },
    RECEIVED: { variant: "success", label: "Received" },
    CLOSED: { variant: "neutral", label: "Closed" },
  };
  const cfg = map[status] ?? { variant: "neutral", label: status };
  return <Badge variant={cfg.variant} label={cfg.label} />;
}

function daysRemainingBadge(days: number | null) {
  if (days === null) return <span className="text-navy/60 text-xs">N/A</span>;
  const cls =
    days <= 7
      ? "bg-red-100 text-red-700"
      : days <= 30
        ? "bg-yellow-100 text-yellow-700"
        : "bg-green-100 text-green-700";
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", cls)}>
      {days} days
    </span>
  );
}

// ─── Quick Restock Modal ──────────────────────────────────────────────────────

function QuickRestockModal({
  suppliers,
  products,
  onClose,
}: {
  suppliers: Supplier[];
  products: { id: string; name: string; sku?: string; unit: string; currentStock: number }[];
  onClose: () => void;
}) {
  const restock = useRecordPurchase();
  const [form, setForm] = React.useState({
    productId: "",
    supplierId: "",
    quantity: "",
    unitCost: "",
    reference: "",
    notes: "",
    backdate: false,
    effectiveDate: "",
  });

  const selectedProduct = products.find((p) => p.id === form.productId);
  const decimalQty = selectedProduct ? isDecimalUnit(selectedProduct.unit) : true;

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
    const qty = Number(form.quantity);
    if (!decimalQty && !Number.isInteger(qty)) {
      alert(`Quantity must be a whole number for unit "${selectedProduct?.unit}"`);
      return;
    }
    restock.mutate(
      {
        productId: form.productId,
        supplierId: form.supplierId || undefined,
        quantity: qty,
        unitCost: Number(form.unitCost),
        reference: form.reference || undefined,
        notes: form.notes || undefined,
        effectiveDate: form.backdate && form.effectiveDate ? form.effectiveDate : undefined,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Quick Restock</h2>
          <p className="mt-0.5 text-xs text-navy/40">For supplier invoices, use{" "}<a href="/purchases" className="text-brand-500 hover:underline">Purchases &rarr; Vendor Bills</a></p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          <div>
            <label className="mb-1 block text-xs text-navy">Supplier</label>
            <select
              value={form.supplierId}
              onChange={(e) => setForm((f) => ({ ...f, supplierId: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">No supplier</option>
              {suppliers.filter((s) => s.isActive).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs text-navy">Product *</label>
            <select
              required
              value={form.productId}
              onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Select product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.sku ? ` (${p.sku})` : ""}
                </option>
              ))}
            </select>
            {selectedProduct && (
              <p className="mt-1 text-xs text-navy/50">
                Current stock: {selectedProduct.currentStock} {selectedProduct.unit}
                {!decimalQty && <span className="ml-2 text-navy/40">(whole numbers only)</span>}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-navy">
                Quantity ({selectedProduct?.unit ?? "units"}) *
              </label>
              <input
                required
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

          {/* Reference combobox */}
          <div ref={refContainerRef} className="relative">
            <label className="mb-1 block text-xs text-navy">PO / Invoice Reference</label>
            <input
              type="text"
              value={form.reference}
              onChange={(e) => { setForm((f) => ({ ...f, reference: e.target.value })); setRefSearch(e.target.value); }}
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
            <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
            <Button type="submit" loading={restock.isPending}>Record Restock</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Adjust Stock Modal ───────────────────────────────────────────────────────

function AdjustStockModal({
  products,
  onClose,
}: {
  products: { id: string; name: string; sku?: string; unit: string; currentStock: number }[];
  onClose: () => void;
}) {
  const recordAdjustment = useRecordAdjustment();
  const [form, setForm] = React.useState({
    productId: "",
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
    const match = products.find(
      (p) => (p.sku ?? "").toLowerCase() === code.toLowerCase(),
    );
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
    ? products.filter((p) =>
        p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
        (p.sku ?? "").toLowerCase().includes(productSearch.toLowerCase())
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
            <label className="mb-1 block text-xs text-navy">Search product</label>
            <input
              ref={barcodeInputRef}
              type="text"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="Type name or SKU, or scan barcode…"
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-navy">Product *</label>
            <select
              required
              value={form.productId}
              onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Select product…</option>
              {filteredProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.sku ? ` (${p.sku})` : ""}
                </option>
              ))}
            </select>
            {productSearch && filteredProducts.length === 0 && (
              <p className="mt-1 text-xs text-navy/40">No products match &quot;{productSearch}&quot;</p>
            )}
            {selectedProduct && (
              <p className="mt-1 text-xs text-navy/50">
                Current stock: {selectedProduct.currentStock} {selectedProduct.unit}
                {form.quantity !== "" && !isNaN(qty) && (
                  <> → <strong>{Number((selectedProduct.currentStock + qty).toFixed(2))} {selectedProduct.unit}</strong></>
                )}
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
            <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
            <Button type="submit" loading={recordAdjustment.isPending}>Save Adjustment</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Create Supplier Modal ────────────────────────────────────────────────────

function CreateSupplierModal({ onClose }: { onClose: () => void }) {
  const createSupplier = useCreateSupplier();
  const [form, setForm] = React.useState({ name: "", contactName: "", phone: "", email: "", notes: "" });

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
            <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
            <Button type="submit" loading={createSupplier.isPending}>Add Supplier</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Create PO Modal ──────────────────────────────────────────────────────────

interface POLineItem {
  productId: string;
  qty: string;
  unitCost: string;
}

function CreatePOModal({
  suppliers,
  products,
  onClose,
  defaultSupplierId,
}: {
  suppliers: Supplier[];
  products: { id: string; name: string; sku?: string }[];
  onClose: () => void;
  defaultSupplierId?: string;
}) {
  const createPO = useCreatePurchaseOrder();
  const { toast } = useToast();
  const [supplierId, setSupplierId] = React.useState(defaultSupplierId ?? "");
  const [expectedDate, setExpectedDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState<POLineItem[]>([{ productId: "", qty: "", unitCost: "" }]);

  const addLine = () => setLines((l) => [...l, { productId: "", qty: "", unitCost: "" }]);
  const removeLine = (i: number) => setLines((l) => l.filter((_, idx) => idx !== i));
  const updateLine = (i: number, field: keyof POLineItem, val: string) =>
    setLines((l) => l.map((line, idx) => (idx === i ? { ...line, [field]: val } : line)));

  const total = lines.reduce((sum, l) => {
    const q = parseFloat(l.qty) || 0;
    const c = parseFloat(l.unitCost) || 0;
    return sum + q * c;
  }, 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const items = lines
      .filter((l) => l.productId && l.qty && l.unitCost)
      .map((l) => ({
        productId: l.productId,
        qty: Number(l.qty),
        unitCost: Number(l.unitCost),
      }));

    if (items.length === 0) {
      toast({ title: "Validation", description: "Add at least one line item.", variant: "warning" });
      return;
    }

    createPO.mutate(
      {
        supplierId: supplierId || undefined,
        expectedDate: expectedDate || undefined,
        items,
        notes: notes || undefined,
      },
      {
        onSuccess: () => {
          toast({ title: "Purchase order created.", variant: "success" });
          onClose();
        },
        onError: () => toast({ title: "Failed to create purchase order.", variant: "error" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Create Purchase Order</h2>
          <button onClick={onClose} className="rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-5 overflow-y-auto px-6 py-5" style={{ maxHeight: "80vh" }}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-navy">Supplier</label>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">No supplier</option>
                {suppliers.filter((s) => s.isActive).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-navy">Expected Date</label>
              <input
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-navy uppercase tracking-wide">Line Items</label>
              <button
                type="button"
                onClick={addLine}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-600 hover:bg-brand-50"
              >
                <Plus className="h-3 w-3" /> Add Row
              </button>
            </div>

            <div className="rounded-lg border border-surface-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-raised text-xs text-navy/70">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-left font-medium w-24">Qty</th>
                    <th className="px-3 py-2 text-left font-medium w-28">Unit Cost ($)</th>
                    <th className="px-3 py-2 text-right font-medium w-24">Subtotal</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {lines.map((line, i) => {
                    const subtotal = (parseFloat(line.qty) || 0) * (parseFloat(line.unitCost) || 0);
                    return (
                      <tr key={i}>
                        <td className="px-3 py-2">
                          <select
                            value={line.productId}
                            onChange={(e) => updateLine(i, "productId", e.target.value)}
                            className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value="">Select…</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}{p.sku ? ` (${p.sku})` : ""}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0.001}
                            step={0.001}
                            placeholder="0"
                            value={line.qty}
                            onChange={(e) => updateLine(i, "qty", e.target.value)}
                            className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            step={0.0001}
                            placeholder="0.00"
                            value={line.unitCost}
                            onChange={(e) => updateLine(i, "unitCost", e.target.value)}
                            className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                        </td>
                        <td className="px-3 py-2 text-right text-navy/70">
                          {subtotal > 0 ? `$${subtotal.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={() => removeLine(i)}
                            disabled={lines.length === 1}
                            className="rounded p-1 text-navy/30 hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t border-surface-border bg-surface-raised/50">
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-right text-xs font-medium text-navy/50">Total</td>
                    <td className="px-3 py-2 text-right text-sm font-semibold text-navy">${total.toFixed(2)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-navy">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full resize-none rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
            <Button type="submit" loading={createPO.isPending}>Create PO</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Receive PO Modal ─────────────────────────────────────────────────────────

function ReceivePOModal({
  po,
  onClose,
}: {
  po: PurchaseOrder;
  onClose: () => void;
}) {
  const receivePO = useReceivePurchaseOrder();
  const { toast } = useToast();
  const [receivedQtys, setReceivedQtys] = React.useState<Record<string, string>>(
    Object.fromEntries(po.items.map((item) => [item.id, String(item.qty)])),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const items = po.items.map((item) => ({
      id: item.id,
      receivedQty: Number(receivedQtys[item.id] ?? 0),
    }));
    receivePO.mutate(
      { id: po.id, items },
      {
        onSuccess: () => {
          toast({ title: "Purchase order received.", variant: "success" });
          onClose();
        },
        onError: () => toast({ title: "Failed to receive purchase order.", variant: "error" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">Receive — {po.poNumber}</h2>
          <button onClick={onClose} className="rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <p className="text-xs text-navy/50">Enter the quantity actually received for each item.</p>
          <div className="rounded-lg border border-surface-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-xs text-navy/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-center font-medium w-24">Ordered</th>
                  <th className="px-3 py-2 text-center font-medium w-28">Received Qty</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {po.items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-3 py-2 font-medium text-navy">{item.productName}</td>
                    <td className="px-3 py-2 text-center text-navy">{item.qty}</td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        step={0.001}
                        value={receivedQtys[item.id] ?? ""}
                        onChange={(e) =>
                          setReceivedQtys((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                        className="w-full rounded border border-surface-border px-2 py-1.5 text-sm text-navy text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
            <Button type="submit" loading={receivePO.isPending}>Confirm Receipt</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── PO Detail Row ────────────────────────────────────────────────────────────

function PODetailRow({
  poId,
  onReceive,
}: {
  poId: string;
  onReceive: (po: PurchaseOrder) => void;
}) {
  const { data: po, isLoading } = usePurchaseOrder(poId);
  const sendPO = useSendPurchaseOrder();
  const closePO = useClosePurchaseOrder();
  const { toast } = useToast();

  if (isLoading) {
    return (
      <tr>
        <td colSpan={8} className="px-6 py-4 text-center text-xs text-navy/40">Loading details…</td>
      </tr>
    );
  }

  if (!po) return null;

  return (
    <tr>
      <td colSpan={8} className="px-6 py-4 bg-surface-raised/40">
        <div className="space-y-3">
          {/* Line items */}
          <div className="rounded-lg border border-surface-border overflow-hidden bg-white">
            <table className="w-full text-xs">
              <thead className="bg-surface-raised text-navy/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Received</th>
                  <th className="px-3 py-2 text-right font-medium">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {(po.items ?? []).map((item: POItem) => (
                  <tr key={item.id}>
                    <td className="px-3 py-2 font-medium text-navy">{item.productName}</td>
                    <td className="px-3 py-2 text-right text-navy/70">{item.qty}</td>
                    <td className="px-3 py-2 text-right text-navy/70">${Number(item.unitCost).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-navy/70">
                      {item.receivedQty ?? <span className="text-navy/30">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-navy/70">
                      ${(item.qty * item.unitCost).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Notes */}
          {po.notes && (
            <p className="text-xs text-navy/50">
              <span className="font-medium">Notes:</span> {po.notes}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {po.status === "DRAFT" && (
              <Button
                size="sm"
                variant="secondary"
                loading={sendPO.isPending}
                onClick={() =>
                  sendPO.mutate(po.id, {
                    onSuccess: () => toast({ title: "PO sent.", variant: "success" }),
                    onError: () => toast({ title: "Failed to send PO.", variant: "error" }),
                  })
                }
              >
                <Send className="h-3 w-3 mr-1" /> Send
              </Button>
            )}
            {(po.status === "SENT" || po.status === "PARTIAL") && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onReceive(po as PurchaseOrder)}
              >
                <PackageCheck className="h-3 w-3 mr-1" /> Receive
              </Button>
            )}
            {(po.status === "SENT" || po.status === "PARTIAL" || po.status === "RECEIVED") && (
              <Button
                size="sm"
                variant="secondary"
                loading={closePO.isPending}
                onClick={() =>
                  closePO.mutate(po.id, {
                    onSuccess: () => toast({ title: "PO closed.", variant: "success" }),
                    onError: () => toast({ title: "Failed to close PO.", variant: "error" }),
                  })
                }
              >
                Close
              </Button>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── Reorder Settings Modal ───────────────────────────────────────────────────

function ReorderSettingsModal({
  item,
  onClose,
}: {
  item: ForecastItem;
  onClose: () => void;
}) {
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
          <button onClick={onClose} className="rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <p className="text-sm text-navy/60">{item.name}</p>
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
            <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
            <Button type="submit" loading={updateSettings.isPending}>Save</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Purchase Orders Tab ──────────────────────────────────────────────────────

function PurchaseOrdersTab({
  suppliers,
  products,
}: {
  suppliers: Supplier[];
  products: { id: string; name: string; sku?: string }[];
}) {
  const [statusFilter, setStatusFilter] = React.useState("");
  const [supplierFilter, setSupplierFilter] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [showCreateModal, setShowCreateModal] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [receivePO, setReceivePO] = React.useState<PurchaseOrder | null>(null);

  const { data: poData, isLoading } = usePurchaseOrders({
    status: statusFilter || undefined,
    supplierId: supplierFilter || undefined,
    from: dateFrom || undefined,
    to: dateTo || undefined,
    page: 1,
    limit: 20,
  });

  const orders: PurchaseOrder[] = poData?.data ?? poData ?? [];

  const toggleExpand = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-navy">Purchase Orders</h2>
        <Button
          size="sm"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setShowCreateModal(true)}
        >
          Create PO
        </Button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All Statuses</option>
          {(["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED"] as POStatus[]).map((s) => (
            <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>
          ))}
        </select>

        <select
          value={supplierFilter}
          onChange={(e) => setSupplierFilter(e.target.value)}
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All Suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          placeholder="From"
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          placeholder="To"
          className="rounded border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {(statusFilter || supplierFilter || dateFrom || dateTo) && (
          <button
            onClick={() => { setStatusFilter(""); setSupplierFilter(""); setDateFrom(""); setDateTo(""); }}
            className="rounded px-2 py-1.5 text-xs text-navy/50 hover:text-navy hover:bg-surface-raised"
          >
            Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-raised" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-surface-border">
          <table className="w-full text-sm">
            <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
              <tr>
                {["PO #", "Supplier", "Status", "Items", "Total", "Expected Date", "Actions", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {orders.map((po) => (
                <React.Fragment key={po.id}>
                  <tr className="transition-colors hover:bg-surface-raised/40">
                    <td className="px-4 py-3 font-mono text-xs font-medium text-navy">{po.poNumber}</td>
                    <td className="px-4 py-3 text-navy/70">{po.supplier?.name ?? "—"}</td>
                    <td className="px-4 py-3">{poStatusBadge(po.status)}</td>
                    <td className="px-4 py-3 text-navy/70">{po.items?.length ?? 0}</td>
                    <td className="px-4 py-3 font-medium text-navy">
                      ${Number(po.total ?? 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-navy/70">
                      {po.expectedDate
                        ? new Date(po.expectedDate).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleExpand(po.id)}
                          title="View details"
                          className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        {po.status === "DRAFT" && (
                          <SendPOButton poId={po.id} />
                        )}
                        {(po.status === "SENT" || po.status === "PARTIAL") && (
                          <button
                            onClick={() => setReceivePO(po)}
                            title="Receive"
                            className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy"
                          >
                            <PackageCheck className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-3">
                      <button
                        onClick={() => toggleExpand(po.id)}
                        className="rounded p-1 text-navy/30 hover:text-navy"
                      >
                        {expandedId === po.id ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                  </tr>
                  {expandedId === po.id && (
                    <PODetailRow
                      poId={po.id}
                      onReceive={setReceivePO}
                    />
                  )}
                </React.Fragment>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-navy/40">
                    No purchase orders found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showCreateModal && (
        <CreatePOModal
          suppliers={suppliers}
          products={products}
          onClose={() => setShowCreateModal(false)}
        />
      )}
      {receivePO && (
        <ReceivePOModal po={receivePO} onClose={() => setReceivePO(null)} />
      )}
    </>
  );
}

// Small inline component to avoid hooks-in-callback issues
function SendPOButton({ poId }: { poId: string }) {
  const sendPO = useSendPurchaseOrder();
  const { toast } = useToast();
  return (
    <button
      onClick={() =>
        sendPO.mutate(poId, {
          onSuccess: () => toast({ title: "PO sent.", variant: "success" }),
          onError: () => toast({ title: "Failed to send PO.", variant: "error" }),
        })
      }
      title="Send"
      disabled={sendPO.isPending}
      className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy disabled:opacity-50"
    >
      <Send className="h-4 w-4" />
    </button>
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
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-20 rounded border border-brand-400 px-2 py-0.5 text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
    );
  }

  return (
    <button
      onClick={() => { setInputVal(value != null ? String(value) : ""); setEditing(true); }}
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
  products: { id: string; name: string; sku?: string }[];
}) {
  const { data: forecastData, isLoading } = useForecasting();
  const updateSettings = useUpdateReorderSettings();
  const { toast } = useToast();
  const items: ForecastItem[] = forecastData ?? [];

  const [createPOItem, setCreatePOItem] = React.useState<ForecastItem | null>(null);

  const handleSaveField = (item: ForecastItem, field: "reorderPoint" | "reorderQty", value: number) => {
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
                  <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
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
                    {item.avgDailySales != null
                      ? Number(item.avgDailySales).toFixed(2)
                      : "—"}
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
                  <td colSpan={8} className="px-4 py-10 text-center text-navy/40">
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Inventory"); }, [setTitle]);

  const { data: stockItems = [], isLoading: stockLoading } = useStockOverview();
  const { data: suppliers = [], isLoading: suppliersLoading } = useSuppliers();
  const { data: productsData } = useProducts({ isActive: true, limit: 0 });
  const products = productsData?.data ?? [];

  const [showRestockModal, setShowPurchaseModal] = React.useState(false);
  const [showAdjustModal, setShowAdjustModal] = React.useState(false);
  const [showSupplierModal, setShowSupplierModal] = React.useState(false);
  const [showAddProductModal, setShowAddProductModal] = React.useState(false);

  const totalInventoryValue = (stockItems as StockItem[]).reduce(
    (sum, item) => sum + (item.totalValue ?? 0),
    0,
  );
  const outOfStockCount = (stockItems as StockItem[]).filter((i) => i.currentStock <= 0).length;

  const tabs = [
    { value: "stock", label: "Stock" },
    { value: "suppliers", label: "Suppliers" },
    { value: "purchase-orders", label: "Purchase Orders" },
    { value: "forecasting", label: "Forecasting" },
  ];

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-navy">Inventory</h1>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs text-navy/50">Total Products</p>
          <p className="mt-1 text-2xl font-bold text-navy">{(stockItems as StockItem[]).length}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-1.5">
            <p className="text-xs text-navy/50">Inventory Value</p>
            {totalInventoryValue === 0 && (
              <span
                title="Value is calculated from average cost per unit. Record purchase receipts in the Vendor Bills tab to populate costs."
                className="cursor-help"
              >
                <Info className="h-3.5 w-3.5 text-navy/30" />
              </span>
            )}
          </div>
          <p className="mt-1 text-2xl font-bold text-navy">${totalInventoryValue.toFixed(2)}</p>
          {totalInventoryValue === 0 && (
            <p className="mt-0.5 text-[10px] text-navy/40">Based on average cost — record purchases to update</p>
          )}
        </Card>
        <Card>
          <p className="text-xs text-navy/50">Out of Stock</p>
          <p className={cn("mt-1 text-2xl font-bold", outOfStockCount > 0 ? "text-danger" : "text-navy")}>
            {outOfStockCount}
          </p>
          {outOfStockCount > (stockItems as StockItem[]).length * 0.5 && (
            <p className="mt-0.5 text-[10px] text-navy/40">Stock may need updating after import</p>
          )}
        </Card>
      </div>

      {/* Import artifact notice */}
      {outOfStockCount > (stockItems as StockItem[]).length * 0.5 && (
        <div className="flex items-start gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
          <p className="text-sm text-brand-700">
            Many products show zero stock because stock quantities were not included in the initial import.
            Use <strong>Quick Restock</strong> or record a purchase receipt to assign stock levels.
          </p>
        </div>
      )}

      <Tabs.Root defaultValue="stock">
        <Tabs.List className="flex gap-1 border-b border-surface-border">
          {tabs.map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "px-4 py-2 text-sm font-medium transition-colors",
                "text-navy/50 hover:text-navy",
                "data-[state=active]:border-b-2 data-[state=active]:border-brand-500 data-[state=active]:text-brand-600",
              )}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {/* ── Stock tab ── */}
        <Tabs.Content value="stock" className="pt-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-navy/50">{(stockItems as StockItem[]).length} products</p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setShowAdjustModal(true)}>
                Adjust Stock
              </Button>
              <Button size="sm" variant="secondary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowAddProductModal(true)}>
                Add Product
              </Button>
              <Button size="sm" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowPurchaseModal(true)}>
                Quick Restock
              </Button>
            </div>
          </div>

          {stockLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-raised" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-surface-border">
              <table className="w-full text-sm">
                <thead className="border-b border-surface-border bg-surface-raised text-xs text-navy/70">
                  <tr>
                    {["Product", "SKU", "Category", "Current Stock", "Per Box"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                    ))}
                    <th className="px-4 py-3 text-left font-medium">
                      <span className="flex items-center gap-1">
                        Unit Cost
                        <span title="Shows standard cost for STANDARD-costing products, or weighted average cost for AVCO/FIFO/LIFO. Updates automatically when vendor bills are received.">
                          <Info className="h-3 w-3 text-navy/30 cursor-help" />
                        </span>
                      </span>
                    </th>
                    <th className="px-4 py-3 text-left font-medium">Total Value</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {(stockItems as StockItem[]).map((item) => (
                    <tr
                      key={item.id}
                      className={cn(
                        "transition-colors hover:bg-surface-raised/50",
                        item.currentStock <= 0 && "bg-danger-bg/30",
                      )}
                    >
                      <td className="px-4 py-3 font-medium text-navy">{item.name}</td>
                      <td className="px-4 py-3 font-mono text-navy">{item.sku ?? "—"}</td>
                      <td className="px-4 py-3 text-navy/70">{item.category ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={cn("font-medium", item.currentStock <= 0 ? "text-danger" : item.currentStock <= 5 ? "text-warning" : "text-navy")}>
                          {Number(item.currentStock) % 1 === 0 ? Number(item.currentStock).toFixed(0) : Number(item.currentStock).toFixed(2)} {item.unit}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-navy/70">
                        {item.unitsPerBox != null ? item.unitsPerBox : "—"}
                      </td>
                      <td className="px-4 py-3 text-navy/70">
                        {item.averageCost != null ? `$${Number(item.averageCost).toFixed(2)}` : "—"}
                      </td>
                      <td className="px-4 py-3 text-navy/70">
                        {item.totalValue != null ? `$${Number(item.totalValue).toFixed(2)}` : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/inventory/movements?product=${item.id}`}
                          className="text-xs text-brand-500 hover:underline"
                        >
                          Movements
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {(stockItems as StockItem[]).length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-navy/40">
                        No products found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Tabs.Content>

        {/* ── Suppliers tab ── */}
        <Tabs.Content value="suppliers" className="pt-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-navy/50">{(suppliers as Supplier[]).length} suppliers</p>
            <Button size="sm" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowSupplierModal(true)}>
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
                      <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
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
                        <Badge variant={s.isActive ? "success" : "neutral"} label={s.isActive ? "Active" : "Inactive"} />
                      </td>
                    </tr>
                  ))}
                  {(suppliers as Supplier[]).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-navy/40">
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
            products={products.map((p: any) => ({ id: p.id, name: p.name, sku: p.sku }))}
          />
        </Tabs.Content>

        {/* ── Forecasting tab ── */}
        <Tabs.Content value="forecasting" className="pt-4">
          <ForecastingTab
            suppliers={suppliers as Supplier[]}
            products={products.map((p: any) => ({ id: p.id, name: p.name, sku: p.sku }))}
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
          }))}
          onClose={() => setShowAdjustModal(false)}
        />
      )}
      {showSupplierModal && (
        <CreateSupplierModal onClose={() => setShowSupplierModal(false)} />
      )}
      <InlineCreateProductModal
        isOpen={showAddProductModal}
        onClose={() => setShowAddProductModal(false)}
        onCreated={() => setShowAddProductModal(false)}
      />
    </div>
  );
}
