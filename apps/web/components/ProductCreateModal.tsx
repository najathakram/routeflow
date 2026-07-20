"use client";

import * as React from "react";
import { ImagePlus, X as XIcon } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { useCreateProduct, useProducts, uploadProductImages } from "@/lib/api/products";
import { apiClient } from "@/lib/api-client";
import { PRODUCT_NAME_SEPARATOR } from "@/lib/product-display";
import { BarcodeScannerButton } from "./BarcodeScannerButton";
import { UnitCombobox } from "./UnitCombobox";
import { CategoryCombobox } from "./CategoryCombobox";
import { SubcategoryCombobox } from "./SubcategoryCombobox";
import { SearchableProductPicker } from "./SearchableProductPicker";
import { useTrackedCategories } from "@/lib/api/tracked-categories";
import { sectionPickerOptions } from "@/lib/regulated-format";

/**
 * Same `CreatedProduct` shape `InlineCreateProductModal` returns — callers
 * (CreateOrderModal, invoices/new, the scan surfaces) rely on
 * unitsPerBox/parentProductId/variantName/parent to drive the Boxes+Pcs
 * editor and the `displayProductName` label for a just-created product.
 */
interface CreatedProduct {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  pricePerUnit: string;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  variantName?: string | null;
  parent?: { name: string } | null;
}

interface ProductCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the newly created product so the caller can auto-select it. */
  onCreated: (product: CreatedProduct) => void;
  /**
   * Units already in use on this tenant's catalog, offered alongside the
   * built-in list in the Unit combobox. Kept as a prop (rather than a hook
   * fetch inside this component) because it's derived page state — the
   * products page's `existingUnits` memo over its already-loaded product
   * list — not a dedicated endpoint; this keeps that call site's diff
   * mechanical.
   */
  units?: string[];
  /** Pre-select a parent product (the products page's "Add variant" flow). */
  defaultParentId?: string;
  /** Pre-fill name from a search term / scanned invoice line. */
  initialName?: string;
  /** Pre-fill SKU from a scanned barcode / scanned invoice line. */
  initialSku?: string;
  /** Suggested sell price (e.g. invoice cost + 30% from a vendor-bill scan) — editable. */
  initialPrice?: number;
  /** Purchase cost carried from a vendor-bill line; pre-fills Standard Cost. */
  initialCost?: number;
  /** Units-per-box prefill from an OCR-read pack size (e.g. "12x330ml") — editable, verify hint shown. */
  initialUnitsPerBox?: number;
}

/** Only prefill units-per-box from a whole number greater than 1 — never guess/round. */
function validUnitsPerBoxPrefill(v: number | undefined): boolean {
  return v != null && Number.isInteger(v) && v > 1;
}

/**
 * The full product-create form — extracted verbatim from the products page's
 * former inline `CreateProductModal` so every surface that needs to create a
 * product from a partial context (a scanned invoice line, a batch-review
 * line) can open the SAME form the products page uses, instead of the
 * slimmer `InlineCreateProductModal`. Owns its own data (parent-candidate
 * catalog, regulated section/subcategory pickers), its own `createProduct`
 * mutation, and the post-create image upload.
 */
export function ProductCreateModal({
  isOpen,
  onClose,
  onCreated,
  units,
  defaultParentId,
  initialName,
  initialSku,
  initialPrice,
  initialCost,
  initialUnitsPerBox,
}: ProductCreateModalProps) {
  const { toast } = useToast();
  const createProduct = useCreateProduct();

  // Every standalone product, for the "Variant of" picker — fetched here so
  // callers don't need to load/pass the full catalog themselves.
  const { data: allProductsData } = useProducts({ limit: 0 });
  const allProducts: any[] = allProductsData?.data ?? [];

  const [form, setForm] = React.useState({
    name: initialName ?? "",
    sku: initialSku ?? "",
    unit: "",
    pricePerUnit: initialPrice != null ? initialPrice.toFixed(2) : "",
    category: "",
    description: "",
    costingMethod: "FIFO",
    standardCost: initialCost != null && initialCost > 0 ? String(initialCost) : "",
    unitsPerBox: validUnitsPerBoxPrefill(initialUnitsPerBox) ? String(initialUnitsPerBox) : "",
    parentProductId: defaultParentId ?? "",
    variantName: "",
    trackedCategoryId: "",
    trackedSubcategoryId: "",
  });

  // Re-sync prefills whenever the modal (re)opens — covers both callers that
  // conditionally mount this component fresh (products page) and callers
  // that keep it mounted and just flip `isOpen` (the scan surfaces).
  React.useEffect(() => {
    if (!isOpen) return;
    setForm((f) => ({
      ...f,
      name: initialName ?? f.name,
      sku: initialSku || f.sku,
      parentProductId: defaultParentId ?? f.parentProductId,
      ...(initialPrice != null ? { pricePerUnit: initialPrice.toFixed(2) } : {}),
      // Suggested from the invoice cost — visible + editable. It's only ever
      // actually SAVED to the product when costingMethod === "STANDARD" (see
      // handleSubmit below, unchanged from the original form); FIFO/other
      // costing methods get their cost from the bill's receive layer
      // instead, so nothing is lost by pre-filling the field here.
      ...(initialCost != null && initialCost > 0 ? { standardCost: String(initialCost) } : {}),
      ...(validUnitsPerBoxPrefill(initialUnitsPerBox)
        ? { unitsPerBox: String(initialUnitsPerBox) }
        : {}),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    initialName,
    initialSku,
    initialPrice,
    initialCost,
    initialUnitsPerBox,
    defaultParentId,
  ]);

  // Pre-populate fields from parent when a parent is selected
  React.useEffect(() => {
    if (!form.parentProductId) return;
    const parent = allProducts.find((p) => p.id === form.parentProductId);
    if (!parent) return;
    setForm((f) => ({
      ...f,
      category: parent.category ?? f.category,
      unit: parent.unit ?? f.unit,
      pricePerUnit: f.pricePerUnit || String(parseFloat(String(parent.pricePerUnit)).toFixed(2)),
      unitsPerBox: f.unitsPerBox || String(parent.unitsPerBox ?? ""),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.parentProductId]);

  const [priceError, setPriceError] = React.useState("");
  const [pendingImages, setPendingImages] = React.useState<File[]>([]);
  const [previews, setPreviews] = React.useState<string[]>([]);
  const [isUploading, setIsUploading] = React.useState(false);
  const [variantOfScanLoading, setVariantOfScanLoading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const barcodeInputRef = React.useRef<HTMLInputElement>(null);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Resolve a scanned barcode to a parent product for the "Variant of" field
  const handleVariantOfScan = async (code: string) => {
    setVariantOfScanLoading(true);
    try {
      const found = await apiClient
        .get(`/products/barcode/${encodeURIComponent(code)}`)
        .then((r) => r.data);
      const parentId: string = found.parentProductId || found.id;
      set("parentProductId", parentId);
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

  // Regulated section + subcategory pickers (both optional). The subcategory
  // list is scoped to the chosen section and cleared when the section changes.
  const { data: sections = [] } = useTrackedCategories({ active: true });
  const sectionOptions = sectionPickerOptions(sections);

  const addImages = (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files);
    setPendingImages((prev) => [...prev, ...arr]);
    arr.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => setPreviews((prev) => [...prev, e.target?.result as string]);
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (idx: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
    setPreviews((prev) => prev.filter((_, i) => i !== idx));
  };

  const resetForm = () => {
    setForm({
      name: "",
      sku: "",
      unit: "",
      pricePerUnit: "",
      category: "",
      description: "",
      costingMethod: "FIFO",
      standardCost: "",
      unitsPerBox: "",
      parentProductId: "",
      variantName: "",
      trackedCategoryId: "",
      trackedSubcategoryId: "",
    });
    setPendingImages([]);
    setPreviews([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.pricePerUnit || parseFloat(form.pricePerUnit) < 0) {
      setPriceError("Please enter a valid price.");
      return;
    }
    setPriceError("");
    // For variants, store ONLY the variant name in the `name` field.
    // The parent product's name stays unchanged; UI composes the full
    // display name (e.g. "Geek Next 50K - Strawberry") from the parent
    // relationship when needed (displayProductName).
    let productName = form.name.trim();
    if (form.parentProductId && form.variantName.trim()) {
      productName = form.variantName.trim();
    }

    let product: CreatedProduct;
    try {
      product = await createProduct.mutateAsync({
        name: productName,
        sku: form.sku || undefined,
        unit: form.unit,
        pricePerUnit: form.pricePerUnit,
        category: form.category || undefined,
        description: form.description || undefined,
        costingMethod: form.costingMethod || "FIFO",
        standardCost:
          form.costingMethod === "STANDARD" && form.standardCost ? form.standardCost : undefined,
        unitsPerBox: form.unitsPerBox ? parseInt(form.unitsPerBox, 10) : undefined,
        parentProductId: form.parentProductId || undefined,
        variantName: form.variantName || undefined,
        trackedCategoryId: form.trackedCategoryId || undefined,
        trackedSubcategoryId: form.trackedSubcategoryId || undefined,
      });
      toast({ title: "Product created", variant: "success" });
    } catch (err: any) {
      toast({
        title: "Failed to create product",
        description: err?.message,
        variant: "error",
      });
      return;
    }

    // Upload images if any were queued
    if (pendingImages.length > 0 && product?.id) {
      setIsUploading(true);
      try {
        await uploadProductImages(product.id, pendingImages);
      } finally {
        setIsUploading(false);
      }
    }

    onCreated(product);
    onClose();
    resetForm();
  };

  if (!isOpen) return null;

  const busy = createProduct.isPending || isUploading;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-surface-border bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">New Product</h2>
          <button onClick={onClose} className="text-navy/70 hover:text-navy transition-colors">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="max-h-[80vh] overflow-y-auto">
          <div className="space-y-4 p-6">
            {/* ── Photos ── */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Photos</label>

              {/* Previews */}
              {previews.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {previews.map((src, i) => (
                    <div
                      key={i}
                      className="relative h-16 w-16 overflow-hidden rounded-lg border border-surface-border"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt={`preview ${i + 1}`}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-danger transition-colors"
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Drop zone / add button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-surface-raised py-3 text-sm text-navy/70 hover:border-brand-500/50 hover:text-brand-500 transition-colors"
              >
                <ImagePlus className="h-4 w-4" />
                {previews.length === 0 ? "Add photos" : "Add more photos"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => addImages(e.target.files)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Variant of — optional parent selector */}
              {allProducts.filter((p) => !p.parentProductId).length > 0 && (
                <div className="col-span-2">
                  <label className="mb-1 block text-sm font-medium text-navy">
                    Variant of <span className="font-normal text-navy/70">(optional)</span>
                  </label>
                  <div className="flex items-stretch gap-2">
                    <SearchableProductPicker
                      value={form.parentProductId}
                      onChange={(id) => set("parentProductId", id)}
                      products={allProducts.filter((p) => !p.parentProductId)}
                      placeholder="Standalone product (type to search)…"
                      className="flex-1"
                    />
                    <BarcodeScannerButton
                      onScan={handleVariantOfScan}
                      title="Scan a variant's barcode to auto-select its parent"
                    />
                  </div>
                  {variantOfScanLoading && (
                    <p className="mt-1 text-xs text-navy/70">Looking up product…</p>
                  )}
                  {form.parentProductId && (
                    <p className="mt-0.5 text-xs text-navy/70">
                      Fields below have been pre-filled from the parent. Adjust as needed.
                    </p>
                  )}
                </div>
              )}
              {form.parentProductId && (
                <div className="col-span-2">
                  <label className="mb-1 block text-sm font-medium text-navy">
                    Flavor / variety <span className="text-danger">*</span>
                  </label>
                  <input
                    required={!!form.parentProductId}
                    autoFocus
                    placeholder='e.g. "Chocolate", "Large", "500ml"'
                    value={form.variantName}
                    onChange={(e) => set("variantName", e.target.value)}
                    className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  {form.variantName.trim() &&
                    allProducts.find((p) => p.id === form.parentProductId) && (
                      <p className="mt-1 rounded bg-surface-raised px-2.5 py-1.5 text-xs text-navy/70">
                        Will appear as:{" "}
                        <span className="font-medium text-navy">
                          {allProducts.find((p) => p.id === form.parentProductId)!.name}
                        </span>
                        <span className="text-navy/70">{PRODUCT_NAME_SEPARATOR}</span>
                        <span className="font-medium text-navy">{form.variantName.trim()}</span>
                      </p>
                    )}
                </div>
              )}
              {/* Name — only for standalone products; variants use auto-composed name */}
              {!form.parentProductId && (
                <div className="col-span-2">
                  <label className="mb-1 block text-sm font-medium text-navy">Name *</label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              )}
              <div className="col-span-2">
                <label className="mb-1 block text-sm font-medium text-navy">SKU / Barcode</label>
                <div className="flex gap-2">
                  <input
                    ref={barcodeInputRef}
                    value={form.sku}
                    onChange={(e) => set("sku", e.target.value)}
                    className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="Scan or enter SKU / barcode"
                  />
                  <BarcodeScannerButton
                    inputRef={barcodeInputRef}
                    onScan={(code) => set("sku", code)}
                    title="Scan barcode"
                  />
                </div>
              </div>

              {/* Unit — combobox (pick from list OR type a custom value) */}
              <div>
                <label className="mb-1 block text-sm font-medium text-navy">Unit *</label>
                <UnitCombobox
                  required
                  value={form.unit}
                  onChange={(v) => set("unit", v)}
                  extraUnits={units}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-navy">Price per unit *</label>
                <div className="flex items-center">
                  <span className="flex h-[38px] items-center rounded-l border border-r-0 border-surface-border bg-surface-raised px-2.5 text-sm text-navy/70">
                    $
                  </span>
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={form.pricePerUnit}
                    onChange={(e) => {
                      set("pricePerUnit", e.target.value);
                      setPriceError("");
                    }}
                    className={`w-full rounded-r border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 ${priceError ? "border-danger focus:ring-danger" : "border-surface-border"}`}
                  />
                </div>
                {priceError && <p className="mt-1 text-xs text-danger">{priceError}</p>}
                {initialCost != null && initialCost > 0 && (
                  <p className="mt-1 text-[11px] text-navy/70">
                    Suggested from invoice cost ${initialCost.toFixed(2)} + 30%. For FIFO/AVCO
                    products the actual cost is recorded when the bill is received.
                  </p>
                )}
              </div>

              {/* Category — pick from the tenant's existing categories OR type a new one */}
              <div className="col-span-2">
                <label className="mb-1 block text-sm font-medium text-navy">Category</label>
                <CategoryCombobox
                  value={form.category}
                  onChange={(v) => set("category", v)}
                  placeholder="Select or type a new category"
                />
              </div>

              {/* Regulated section + subcategory (optional) — see /settings?tab=regulated */}
              {sectionOptions.length > 0 && (
                <>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-navy">
                      Regulated section
                    </label>
                    <select
                      value={form.trackedCategoryId}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          trackedCategoryId: e.target.value,
                          trackedSubcategoryId: "",
                        }))
                      }
                      className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      <option value="">None (not regulated)</option>
                      {sectionOptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.inactive ? " (inactive)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-navy">Subcategory</label>
                    <SubcategoryCombobox
                      sectionId={form.trackedCategoryId || null}
                      value={form.trackedSubcategoryId}
                      onChange={(id) => set("trackedSubcategoryId", id)}
                    />
                  </div>
                </>
              )}

              <div className="col-span-2">
                <label className="mb-1 block text-sm font-medium text-navy">Description</label>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  className="w-full resize-y rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              {/* ── Costing method ── */}
              <div>
                <label className="mb-1 block text-sm font-medium text-navy">Costing Method</label>
                <select
                  value={form.costingMethod}
                  onChange={(e) => set("costingMethod", e.target.value)}
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="FIFO">FIFO — First In, First Out</option>
                  <option value="LIFO">LIFO — Last In, First Out</option>
                  <option value="AVCO">AVCO — Weighted Average Cost</option>
                  <option value="LAST_COST">Last Cost — most recent purchase price</option>
                  <option value="STANDARD">Standard Cost</option>
                </select>
              </div>

              {form.costingMethod === "STANDARD" && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-navy">
                    Standard Cost *
                  </label>
                  <input
                    required={form.costingMethod === "STANDARD"}
                    type="number"
                    min="0"
                    step="0.0001"
                    value={form.standardCost}
                    onChange={(e) => set("standardCost", e.target.value)}
                    placeholder="e.g. 1.2500"
                    className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-navy">Units per box</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="e.g. 12"
                  value={form.unitsPerBox}
                  onChange={(e) => set("unitsPerBox", e.target.value)}
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <p className="mt-0.5 text-xs text-navy/70">
                  How many individual units are in one box (optional)
                </p>
                {validUnitsPerBoxPrefill(initialUnitsPerBox) &&
                  form.unitsPerBox === String(initialUnitsPerBox) && (
                    <p className="mt-0.5 text-[11px] text-navy/70">
                      Suggested from the invoice line ({initialUnitsPerBox} per box) — verify before
                      saving.
                    </p>
                  )}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-surface-border px-6 py-4">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {isUploading ? "Uploading photos…" : "Create Product"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
