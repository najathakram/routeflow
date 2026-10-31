"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { formatReceiptMoney, unitWords } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import { useCreateProduct, useProducts } from "@/lib/api/products";
import { apiClient } from "@/lib/api-client";
import { PRODUCT_NAME_SEPARATOR } from "@/lib/product-display";
import { codedToastCopy } from "@/lib/generic-toast-copy";
import { isReadOnlyRefusal } from "@/lib/product-reactivation-refusal";
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
  /** Present so callers can enable the Boxes+Pcs editor for boxed products. */
  unitsPerBox?: number | null;
  /** Variant linkage so callers can label the line "Parent - Flavor". */
  parentProductId?: string | null;
  variantName?: string | null;
  parent?: { name: string } | null;
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
  /** Suggested sell price (e.g. invoice cost + 30% from a vendor-bill scan) — editable */
  initialPrice?: number;
  /** Purchase cost carried from a vendor-bill line; saved as the product's standardCost */
  initialCost?: number;
  /** The counter: Save stays off until the price is above $0 (a blank price would sell a $0 line). */
  requirePrice?: boolean;
}

/** SA-1071 I4: a new item's price at or above this gets a "check the price" note. A note, never a block. */
export const NEW_ITEM_PRICE_CHECK = 1000;

/** I2a (SA-1071): sku, barcode and unitSku share one input here, so the sentence names which one the server meant. */
const codeInUseCopy = (field: string | undefined): string =>
  field === "barcode"
    ? "That barcode is already used by another item."
    : field === "unitSku"
      ? "That unit code is already used by another item."
      : "That code is already used by another item.";
const PRICE_REQUIRED_COPY = "Enter a price to sell this item.";
const PRICE_BELOW_ZERO_COPY = "A price can't be below $0.00.";
const PRICE_DECIMALS_COPY = "Use at most two decimals, like 12.50.";
const UNITS_PER_BOX_COPY = "Enter a whole number, 1 or more.";

type FieldErrors = { name?: string; unit?: string; price?: string; units?: string };

export function InlineCreateProductModal({
  isOpen,
  onClose,
  onCreated,
  initialName = "",
  initialSku = "",
  initialPrice,
  initialCost,
  requirePrice = false,
}: InlineCreateProductModalProps) {
  const { toast } = useToast();
  const w = unitWords();
  // SA-1071 I2: this window toasts its own refusals (below), so the app-wide toast must not add a second.
  const createProduct = useCreateProduct({ localErrorToast: true });
  const submittingRef = React.useRef(false);
  const skuInputRef = React.useRef<HTMLInputElement>(null);
  const [codeInUse, setCodeInUse] = React.useState<string | null>(null);
  const codeErrId = React.useId();
  // SA-1071 I3: a failed submit names the field (Name, Unit, Price), marks it invalid and puts the cursor on the first.
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const nameRef = React.useRef<HTMLInputElement>(null);
  const priceRef = React.useRef<HTMLInputElement>(null);
  const unitsRef = React.useRef<HTMLInputElement>(null);
  const unitId = React.useId();
  const nameErrId = React.useId();
  const unitErrId = React.useId();
  const unitsErrId = React.useId();
  const priceNoteId = React.useId();

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

  const priceOk = Number(form.pricePerUnit) > 0;
  const priceBelowZero = form.pricePerUnit.trim() !== "" && Number(form.pricePerUnit) < 0;
  // The price line: a typed negative is wrong on every door; a blank price only matters where one is required (the counter).
  const priceError = fieldErrors.price ?? (priceBelowZero ? PRICE_BELOW_ZERO_COPY : null);
  const priceHint = priceError ? null : requirePrice && !priceOk ? PRICE_REQUIRED_COPY : null;
  const priceCheck = Number(form.pricePerUnit) >= NEW_ITEM_PRICE_CHECK;

  // Loading state while resolving a scanned barcode → parent product
  const [variantOfScanLoading, setVariantOfScanLoading] = React.useState(false);

  // Fetch every product (active + inactive) so the operator can pick any
  // standalone product as a parent — including ones they archived earlier
  // but want to revive as a variant root.
  const { data: allProductsData } = useProducts({ limit: 0 });
  const parentCandidates = (allProductsData?.data ?? []).filter((p: any) => !p.parentProductId);

  // Derived: the selected parent product object (for name preview)
  const selectedParent = parentCandidates.find((p: any) => p.id === form.parentProductId) as any;

  // Sync initial prefills when modal opens
  React.useEffect(() => {
    if (isOpen) {
      setForm((f) => ({
        ...f,
        name: initialName,
        sku: initialSku || "",
        ...(initialPrice != null ? { pricePerUnit: initialPrice.toFixed(2) } : {}),
      }));
    }
  }, [isOpen, initialName, initialSku, initialPrice]);

  // SA-1066 FL1: Escape closes the window by the same call as Cancel and X (none of the three asks about a discard). Read at the
  // window in the capture phase so it works wherever focus sits, and so an order-builder Modal around us (Radix reads Escape at the
  // document, also in capture) is not closed with it. An open Unit / Category / parent list sets `aria-controls` on its input and
  // takes the first Escape: we only mark the event handled (`preventDefault`, which Radix honours by not dismissing) and let it
  // reach the list. Without that mark the builder closed too, losing the order.
  React.useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // IME composition (isComposing / legacy keyCode 229, as use-listbox-nav reads it): that Escape cancels the composition, so
      // we do not close. We still mark it handled: Radix reads it next and would dismiss the order builder around us. The mark
      // does not touch the IME (a keydown during composition is not cancelable as far as the IME is concerned).
      if (e.isComposing || e.keyCode === 229) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if ((e.target as Element | null)?.hasAttribute?.("aria-controls")) return; // the list closes itself
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, onClose]);

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
    // display name as `<parent.name> - <variant.variantName>` (displayProductName)
    // when needed. This keeps the parent product's own name unchanged and avoids
    // redundant prefixes baked into every variant row.
    const productName = form.parentProductId ? form.variantName.trim() : form.name.trim();
    // SA-1071 I3: the form is `noValidate`, so every client failure is named here, in field order.
    const found: FieldErrors = {};
    if (!productName)
      found.name = form.parentProductId
        ? "Enter a flavor or variety."
        : "Enter a name for this item.";
    if (!form.unit.trim()) found.unit = "Choose a unit, like each or case.";
    if (priceBelowZero) found.price = PRICE_BELOW_ZERO_COPY;
    else if (requirePrice && !priceOk) found.price = PRICE_REQUIRED_COPY;
    else if (!/^\d*(\.\d{0,2})?$/.test(form.pricePerUnit.trim())) found.price = PRICE_DECIMALS_COPY;
    const units = form.unitsPerBox.trim();
    if (units && (!/^\d+$/.test(units) || Number(units) < 1)) found.units = UNITS_PER_BOX_COPY;
    if (found.name || found.unit || found.price || found.units) {
      setFieldErrors(found);
      const target = found.name
        ? nameRef.current
        : found.unit
          ? document.getElementById(unitId)
          : found.price
            ? priceRef.current
            : unitsRef.current;
      target?.focus();
      return;
    }
    // I-79: one create per attempt. `loading` disables the button only after a re-render, so a second click in the
    // same frame would POST again and come back 409; the ref drops it until this attempt settles.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setCodeInUse(null);

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
        // Purchase cost carried from a vendor-bill line (finish-later quick create).
        ...(initialCost != null && initialCost > 0 ? { standardCost: String(initialCost) } : {}),
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
        onError: (err: unknown) => {
          const res = (
            err as {
              response?: { status?: number; data?: { code?: string; field?: string } };
            } | null
          )?.response;
          if (res?.status === 400 && res.data?.code === API_ERROR_CODES.PRODUCT_CODE_IN_USE) {
            setCodeInUse(codeInUseCopy(res.data.field));
            skuInputRef.current?.focus();
            return;
          }
          // A read-only workspace already has its own toast; this one names the problem for every other refusal, once.
          if (isReadOnlyRefusal(err)) return;
          toast({
            title: "Failed to create product",
            description: codedToastCopy(err) ?? "Check the details and try again.",
            variant: "error",
          });
        },
        onSettled: () => {
          submittingRef.current = false;
        },
      },
    );
  };

  const isVariant = !!form.parentProductId;

  return (
    <div
      // W-1042: the counter reads this and holds scans and focus while the window is open. Not a dialog role: this
      // window also sits inside the order builder's Modal, and a nested role would break its Unit and Category picks.
      data-scan-pause
      className="fixed inset-0 z-[200] !mt-0 flex items-center justify-center bg-black/50 p-4 max-md:[&_input]:text-base max-md:[&_select]:text-base max-md:[&_textarea]:text-base"
    >
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-navy">New product</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4 px-6 py-4">
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
                ref={nameRef}
                autoFocus
                type="text"
                value={form.variantName}
                onChange={(e) => {
                  setForm((f) => ({ ...f, variantName: e.target.value }));
                  setFieldErrors((x) => ({ ...x, name: undefined }));
                }}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? nameErrId : undefined}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder='e.g. "Chocolate", "Large", "500ml"'
              />
              {fieldErrors.name && (
                <p id={nameErrId} role="alert" className="mt-1 text-[11px] text-danger">
                  {fieldErrors.name}
                </p>
              )}
              {/* Display preview — variant rows show their flavor; parent context
                  comes from the relationship, not from being baked into the name. */}
              {selectedParent && (
                <p className="mt-1.5 rounded bg-surface-raised px-2.5 py-1.5 text-xs text-navy/70">
                  Will appear as:{" "}
                  <span className="font-medium text-navy">{selectedParent.name}</span>
                  <span className="text-navy/70">{PRODUCT_NAME_SEPARATOR}</span>
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
                ref={nameRef}
                autoFocus
                type="text"
                value={form.name}
                onChange={(e) => {
                  setForm((f) => ({ ...f, name: e.target.value }));
                  setFieldErrors((x) => ({ ...x, name: undefined }));
                }}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? nameErrId : undefined}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="e.g. Sourdough Bread"
              />
              {fieldErrors.name && (
                <p id={nameErrId} role="alert" className="mt-1 text-[11px] text-danger">
                  {fieldErrors.name}
                </p>
              )}
            </div>
          )}

          {/* ── SKU (barcode scanner) + Unit ── */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">SKU / Barcode</label>
              <div className="flex gap-2">
                <input
                  ref={skuInputRef}
                  type="text"
                  value={form.sku}
                  onChange={(e) => {
                    setCodeInUse(null);
                    setForm((f) => ({ ...f, sku: e.target.value }));
                  }}
                  aria-invalid={codeInUse ? true : undefined}
                  aria-describedby={codeInUse ? codeErrId : undefined}
                  className="min-w-0 flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Scan or type"
                />
                <BarcodeScannerButton
                  inputRef={skuInputRef}
                  onScan={(code) => {
                    setCodeInUse(null);
                    setForm((f) => ({ ...f, sku: code }));
                  }}
                  title="Scan barcode"
                />
              </div>
              {codeInUse && (
                <p id={codeErrId} role="alert" className="mt-1 text-sm font-medium text-red-700">
                  {codeInUse}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Unit *</label>
              <UnitCombobox
                id={unitId}
                value={form.unit}
                onChange={(v) => {
                  setForm((f) => ({ ...f, unit: v }));
                  setFieldErrors((x) => ({ ...x, unit: undefined }));
                }}
                invalid={!!fieldErrors.unit}
                describedBy={fieldErrors.unit ? unitErrId : undefined}
              />
              {fieldErrors.unit && (
                <p id={unitErrId} role="alert" className="mt-1 text-[11px] text-danger">
                  {fieldErrors.unit}
                </p>
              )}
            </div>
          </div>

          {/* ── Price + Category ── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-navy">Price ($)</label>
              <input
                ref={priceRef}
                type="number"
                min={0}
                step={0.01}
                value={form.pricePerUnit}
                onChange={(e) => {
                  setForm((f) => ({ ...f, pricePerUnit: e.target.value }));
                  setFieldErrors((x) => ({ ...x, price: undefined }));
                }}
                // SA-1071 I4: the retype is one step, not select-then-type
                onFocus={(e) => e.currentTarget.select()}
                aria-invalid={priceError ? true : undefined}
                aria-describedby={priceError || priceHint || priceCheck ? priceNoteId : undefined}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="0.00"
              />
              <div id={priceNoteId}>
                {priceError && (
                  <p role="alert" className="mt-1 text-[11px] text-danger">
                    {priceError}
                  </p>
                )}
                {priceHint && <p className="mt-1 text-[11px] text-navy/70">{priceHint}</p>}
                {!priceError && priceCheck && (
                  <p className="mt-1 text-[11px] text-navy">
                    That&apos;s {formatReceiptMoney(Number(form.pricePerUnit))} each. Check the
                    price before you save.
                  </p>
                )}
              </div>
              {initialCost != null && initialCost > 0 && (
                <p className="mt-1 text-[11px] text-navy/70">
                  Suggested from invoice cost ${initialCost.toFixed(2)} + 30%. Cost is saved to the
                  product — finish setup later from its page.
                </p>
              )}
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
            <label className="mb-1 block text-xs font-medium text-navy">
              {w.base.other} per {w.pack.lower}
            </label>
            <input
              ref={unitsRef}
              type="number"
              min={1}
              step={1}
              value={form.unitsPerBox}
              onChange={(e) => {
                setForm((f) => ({ ...f, unitsPerBox: e.target.value }));
                setFieldErrors((x) => ({ ...x, units: undefined }));
              }}
              aria-invalid={fieldErrors.units ? true : undefined}
              aria-describedby={fieldErrors.units ? unitsErrId : undefined}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="e.g. 12 (optional)"
            />
            {fieldErrors.units && (
              <p id={unitsErrId} role="alert" className="mt-1 text-[11px] text-danger">
                {fieldErrors.units}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={createProduct.isPending}
              disabled={requirePrice && !priceOk}
            >
              Create product
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
