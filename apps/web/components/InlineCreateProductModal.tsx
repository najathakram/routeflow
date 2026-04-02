"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { useCreateProduct } from "@/lib/api/products";
import { BarcodeScannerButton } from "./BarcodeScannerButton";
import { UnitCombobox } from "./UnitCombobox";

interface CreatedProduct {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  pricePerUnit: string;
  averageCost?: string;
}

interface InlineCreateProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the newly created product so the caller can auto-select it */
  onCreated: (product: CreatedProduct) => void;
  /** Pre-fill name from a search term the operator typed */
  initialName?: string;
}

export function InlineCreateProductModal({
  isOpen,
  onClose,
  onCreated,
  initialName = "",
}: InlineCreateProductModalProps) {
  const { toast } = useToast();
  const createProduct = useCreateProduct();
  const skuInputRef = React.useRef<HTMLInputElement>(null);

  const [form, setForm] = React.useState({
    name: initialName,
    sku: "",
    unit: "",
    pricePerUnit: "",
    category: "",
    unitsPerBox: "",
  });

  // Sync initialName when it changes
  React.useEffect(() => {
    if (isOpen) {
      setForm((f) => ({ ...f, name: initialName }));
    }
  }, [isOpen, initialName]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;

    createProduct.mutate(
      {
        name: form.name.trim(),
        sku: form.sku.trim() || undefined,
        unit: form.unit,
        pricePerUnit: form.pricePerUnit || "0",
        category: form.category.trim() || undefined,
        unitsPerBox: form.unitsPerBox ? parseInt(form.unitsPerBox, 10) : undefined,
      },
      {
        onSuccess: (product: CreatedProduct) => {
          toast({ title: "Product created", description: `${product.name} has been added.`, variant: "success" });
          onCreated(product);
          onClose();
          setForm({ name: "", sku: "", unit: "", pricePerUnit: "", category: "", unitsPerBox: "" });
        },
        onError: () => {
          toast({ title: "Failed to create product", description: "Check the details and try again.", variant: "error" });
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">New Product</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/40 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Name *</label>
            <input
              required
              autoFocus
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="e.g. Sourdough Bread"
            />
          </div>

          {/* SKU (barcode scanner) + Unit */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">SKU / Barcode</label>
              <div className="flex gap-2">
                <input
                  ref={skuInputRef}
                  type="text"
                  value={form.sku}
                  onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                  className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Scan or type"
                />
                <BarcodeScannerButton
                  inputRef={skuInputRef}
                  onScan={(code) => setForm((f) => ({ ...f, sku: code }))}
                  title="Scan barcode"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Unit *</label>
              <UnitCombobox
                required
                value={form.unit}
                onChange={(v) => setForm((f) => ({ ...f, unit: v }))}
              />
            </div>
          </div>

          {/* Price + Category */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Price ($)</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={form.pricePerUnit}
                onChange={(e) => setForm((f) => ({ ...f, pricePerUnit: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Category</label>
              <input
                type="text"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="e.g. Bakery"
              />
            </div>
          </div>

          {/* Units per box */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Units per box</label>
            <input
              type="number"
              min={1}
              step={1}
              value={form.unitsPerBox}
              onChange={(e) => setForm((f) => ({ ...f, unitsPerBox: e.target.value }))}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="e.g. 12 (optional)"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={createProduct.isPending}>
              Create Product
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
