"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { useCreateProduct, useProducts } from "@/lib/api/products";
import { apiClient } from "@/lib/api-client";
import { BarcodeScannerButton } from "./BarcodeScannerButton";
import { UnitCombobox } from "./UnitCombobox";
import { CategoryCombobox } from "./CategoryCombobox";
import { SearchableProductPicker } from "./SearchableProductPicker";

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
  /** Pre-fill SKU from a scanned barcode */
  initialSku?: string;
}

export function InlineCreateProductModal({
  isOpen,
  onClose,
  onCreated,
  initialName = "",
  initialSku = "",
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
    parentProductId: "",
    variantName: "",
  });

  // Loading state while resolving a scanned barcode → parent product
  const [variantOfScanLoading, setVariantOfScanLoading] = React.useState(false);

  // Fetch every product (active + inactive) so the operator can pick any
  // standalone product as a parent — including ones they archived earlier
  // but want to revive as a variant root.
  const { data: allProductsData } = useProducts({ limit: 0 });
  const parentCandidates = (allProductsData?.data ?? []).filter((p: any) => !p.parentProductId);

  // Derived: the selected parent product object (for name preview)
  const selectedParent = parentCandidates.find((p: any) => p.id === form.parentProductId) as any;

  // Sync initialName / initialSku when modal opens
  React.useEffect(() => {
    if (isOpen) {
      setForm((f) => ({ ...f, name: initialName, sku: initialSku || "" }));
    }
  }, [isOpen, initialName, initialSku]);

  if (!isOpen) return null;

  /**
   * Scanning a barcode in the "Variant of" field:
   * - Look up the product by barcode
   * - If the result is itself a variant, resolve to its parent
   * - Auto-select that parent in the dropdown
   */
  const handleVariantOfScan = async (code: string) => {
    setVariantOfScanLoading(true);
    try {
      const found = await apiClient
        .get(`/products/barcode/${encodeURIComponent(code)}`)
        .then((r) => r.data);
      // If the scanned product is a variant, use its parentProductId; otherwise use its own id
      const parentId: string = found.parentProductId || found.id;
      setForm((f) => ({ ...f, parentProductId: parentId }));
    } catch {
      toast({
        title: "Product not found",
        description: "No product matches that barcode. Select a parent from the list manually.",
        variant: "error",
      });
    } finally {
      setVariantOfScanLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // For variants the `name` field stores ONLY the variant name (e.g. "Strawberry").
    // The parent context comes from `parentProductId` — UI components compose the
    // display name as `<parent.name> · <variant.variantName>` when needed. This
    // keeps the parent product's own name unchanged and avoids redundant prefixes
    // baked into every variant row.
    let productName = form.name.trim();
    if (form.parentProductId) {
      if (!form.variantName.trim()) {
        toast({ title: "Variant name is required", variant: "error" });
        return;
      }
      productName = form.variantName.trim();
    } else if (!productName) {
      return;
    }

    createProduct.mutate(
      {
        name: productName,
        sku: form.sku.trim() || undefined,
        unit: form.unit,
        pricePerUnit: form.pricePerUnit || "0",
        category: form.category.trim() || undefined,
        unitsPerBox: form.unitsPerBox ? parseInt(form.unitsPerBox, 10) : undefined,
        parentProductId: form.parentProductId || undefined,
        variantName: form.variantName.trim() || undefined,
      },
      {
        onSuccess: (product: CreatedProduct) => {
          toast({
            title: "Product created",
            description: `${product.name} has been added.`,
            variant: "success",
          });
          onCreated(product);
          onClose();
          setForm({
            name: "",
            sku: "",
            unit: "",
            pricePerUnit: "",
            category: "",
            unitsPerBox: "",
            parentProductId: "",
            variantName: "",
          });
        },
        onError: () => {
          toast({
            title: "Failed to create product",
            description: "Check the details and try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const isVariant = !!form.parentProductId;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">New Product</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-4">
          {/* ── Variant of — optional parent ── */}
          {parentCandidates.length > 0 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">
                Variant of <span className="font-normal text-navy/70">(optional)</span>
              </label>
              <div className="flex items-stretch gap-2">
                <SearchableProductPicker
                  value={form.parentProductId}
                  onChange={(id) => setForm((f) => ({ ...f, parentProductId: id }))}
                  products={parentCandidates}
                  placeholder="Standalone product (type to search)…"
                  className="flex-1"
                />
                <BarcodeScannerButton
                  onScan={handleVariantOfScan}
                  title="Scan a product barcode to auto-select its master"
                />
              </div>
              {variantOfScanLoading && (
                <p className="mt-1 text-xs text-navy/70">Looking up product…</p>
              )}
            </div>
          )}

          {/* ── Variant name (required when a parent is selected) ── */}
          {isVariant && (
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">
                Flavor / Variety <span className="text-danger">*</span>
              </label>
              <input
                required
                autoFocus
                type="text"
                value={form.variantName}
                onChange={(e) => setForm((f) => ({ ...f, variantName: e.target.value }))}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder='e.g. "Chocolate", "Large", "500ml"'
              />
              {/* Display preview — variant rows show their flavor; parent context
                  comes from the relationship, not from being baked into the name. */}
              {selectedParent && (
                <p className="mt-1.5 rounded bg-surface-raised px-2.5 py-1.5 text-xs text-navy/70">
                  Will appear as:{" "}
                  <span className="font-medium text-navy">{selectedParent.name}</span>
                  <span className="text-navy/70"> · </span>
                  <span className="font-medium text-navy">{form.variantName.trim() || "…"}</span>
                </p>
              )}
            </div>
          )}

          {/* ── Name — only for standalone products ── */}
          {!isVariant && (
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
          )}

          {/* ── SKU (barcode scanner) + Unit ── */}
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

          {/* ── Price + Category ── */}
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
              <CategoryCombobox
                value={form.category}
                onChange={(v) => setForm((f) => ({ ...f, category: v }))}
                placeholder="e.g. Bakery"
              />
            </div>
          </div>

          {/* ── Units per box ── */}
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
