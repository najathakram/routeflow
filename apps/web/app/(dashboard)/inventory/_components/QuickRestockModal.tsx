"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { SearchableProductPicker } from "@/components/SearchableProductPicker";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { archivedMessage, resolveProductByCode } from "@/lib/barcode-resolve";
import { DidYouMeanPicker } from "@/components/scan/DidYouMeanPicker";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { unitsLabel } from "@/lib/stock-label";
import { useRecordPurchase, usePurchaseOrders } from "@/lib/api/inventory";
import { useVendorBills } from "@/lib/api/vendor-bills";
import { SupplierSelect } from "@/components/SupplierSelect";
import type { Supplier } from "./purchase-orders-shared";

const DECIMAL_UNITS = ["kg", "g", "liter", "litre", "l", "oz", "lb", "pound", "ml"];
function isDecimalUnit(unit: string) {
  return DECIMAL_UNITS.includes(unit.toLowerCase());
}

// ─── Quick Restock Modal ──────────────────────────────────────────────────────

export function QuickRestockModal({
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
  const [scanMatches, setScanMatches] = React.useState<any[]>([]);
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
      } else if (!result.notFound && (result.suggestion || result.ambiguous)) {
        // B1219: a fuzzy guess selects the product only after the operator confirms it.
        setScanMatches(result.matches?.length ? result.matches : [result.product]);
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
              Supplier Bills
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
            {scanMatches.length > 0 && (
              <div className="mt-2">
                <DidYouMeanPicker
                  matches={scanMatches}
                  confirmLabel="Apply"
                  onConfirm={(product) => {
                    setScanMatches([]);
                    setForm((f) => ({ ...f, productId: product.id }));
                    qtyInputRef.current?.focus();
                  }}
                  onCancel={() => setScanMatches([])}
                />
              </div>
            )}
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
