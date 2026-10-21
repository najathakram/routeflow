"use client";

import * as React from "react";
import { ImagePlus, X as XIcon } from "lucide-react";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { unitWords, validateSetPrice } from "@routeflow/pricing";
import type { SavePricesRequest } from "@routeflow/types";
import { useCreateProduct, useProducts, uploadProductImages } from "@/lib/api/products";
import { apiClient } from "@/lib/api-client";
import { fetchPriceGrid } from "@/lib/api/usePriceGrid";
import { usePricesV2Enabled } from "@/lib/api/units-v2";
import { useUnitsEnabled } from "@/lib/api/product-units";
import { PRODUCT_NAME_SEPARATOR } from "@/lib/product-display";
import { isPackUnit, priceUnitWord } from "@/lib/product-unit-label";
import { priceQtyHint } from "@/lib/price-qty-hint";
import { BarcodeScannerButton } from "./BarcodeScannerButton";
import { PackSizePrompt } from "./PackSizePrompt";
import { UnitCombobox } from "./UnitCombobox";
import { RestoreDraftBanner } from "./product-create/RestoreDraftBanner";
import {
  EMPTY_DRAFT_FORM,
  useProductCreateDraft,
  type DraftFields,
} from "./product-create/product-create-draft";
import { CategoryCombobox } from "./CategoryCombobox";
import { SubcategoryCombobox } from "./SubcategoryCombobox";
import { SearchableProductPicker } from "./SearchableProductPicker";
import {
  useTrackedCategories,
  useRegulatedTemplates,
  type ReportTemplateDef,
} from "@/lib/api/tracked-categories";
import { sectionPickerOptions } from "@/lib/regulated-format";
import { safeTextErrorCopy } from "@/lib/safe-text-error-copy";
import { localToastForSafeTextRefusal } from "@/lib/local-error-toast";

/**
 * Same `CreatedProduct` shape `InlineCreateProductModal` returns — callers
 * (CreateOrderModal, invoices/new, the scan surfaces) rely on
 * unitsPerBox/parentProductId/variantName/parent to drive the Boxes+Pcs
 * editor and the `displayProductName` label for a just-created product.
 */
const FORM_ID = "product-create-form";
/** K11-27: how long the "created" toast stays (the default 4 s is gone before a slow reader looks up). */
const CREATED_TOAST_MS = 5000;

/**
 * Every row above the Name field that depends on async data is mounted from the first render inside
 * a wrapper of this minimum height (label 20 + gap 4 + control 34), so the Name field sits where it
 * will settle before the catalog arrives. Never mount such a row conditionally on its query.
 */
const RESERVED_ROW = "min-h-[58px]";

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

/**
 * Is a Unit / Category / product list open INSIDE the dialog the Escape came from? Inline lists live in the dialog;
 * AnchoredList portals to <body> and stamps the owning dialog's id. A list elsewhere on the page is not ours.
 */
function listOpenInDialog(target: EventTarget | null): boolean {
  const dialog =
    (target instanceof Element ? target.closest('[role="dialog"]') : null) ??
    document.querySelector('[role="dialog"]');
  if (!dialog) return false;
  if (dialog.querySelector('[role="listbox"]')) return true;
  return (
    !!dialog.id &&
    document.querySelector(`[data-anchored-list][data-anchored-owner="${dialog.id}"]`) !== null
  );
}

/** Only prefill units-per-box from a whole number greater than 1 — never guess/round. */
function validUnitsPerBoxPrefill(v: number | undefined): boolean {
  return v != null && Number.isInteger(v) && v > 1;
}

/**
 * Non-null `productConfig` shape for a report template that needs per-product
 * regulatory config (e.g. TX Comptroller). See `regulated/template-registry.ts`.
 */
type RegProductConfig = NonNullable<ReportTemplateDef["productConfig"]>;

/** UoM options for a chosen item type; empty until an item type is picked. */
function uomsForItemType(
  productConfig: RegProductConfig | null,
  itemType: string,
): RegProductConfig["itemTypes"][number]["uoms"] {
  if (!productConfig || !itemType) return [];
  return productConfig.itemTypes.find((t) => t.code === itemType)?.uoms ?? [];
}

/**
 * The full product-create form — extracted verbatim from the products page's
 * former inline `CreateProductModal` so every surface that needs to create a
 * product from a partial context (a scanned invoice line, a batch-review
 * line) can open the SAME form the products page uses, instead of the
 * slimmer `InlineCreateProductModal`. Owns its own data (parent-candidate
 * catalog, regulated type/category pickers), its own `createProduct`
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
  const w = unitWords();
  const createProduct = useCreateProduct({ localErrorToast: localToastForSafeTextRefusal });

  // Every standalone product, for the "Variant of" picker — fetched here so
  // callers don't need to load/pass the full catalog themselves.
  const { data: allProductsData } = useProducts({ limit: 0 });
  const allProducts: any[] = allProductsData?.data ?? [];
  const parentCandidates = allProducts.filter((p) => !p.parentProductId);
  // Only once the catalog has loaded: while it is on its way "no products" would be a claim, not a fact.
  const noProductsYet = allProductsData !== undefined && parentCandidates.length === 0;

  const [form, setForm] = React.useState<DraftFields>({
    name: initialName ?? "",
    sku: initialSku ?? "",
    barcode: "",
    unitSku: "",
    unit: "",
    pricePerUnit: initialPrice != null ? initialPrice.toFixed(2) : "",
    category: "",
    description: "",
    costingMethod: "AVCO",
    standardCost: initialCost != null && initialCost > 0 ? String(initialCost) : "",
    unitsPerBox: validUnitsPerBoxPrefill(initialUnitsPerBox) ? String(initialUnitsPerBox) : "",
    pricePerPiece: "",
    parentProductId: defaultParentId ?? "",
    variantName: "",
    trackedCategoryId: "",
    trackedSubcategoryId: "",
    regItemType: "",
    regUomCase: "",
    regUomUnit: "",
  });

  // K11-26: what "pristine" is measured against. Every PROGRAMMATIC change (a prefill, a parent's pre-fill, a
  // restored draft, a reset) is applied to this baseline as well, so only the operator's own typing makes the
  // form dirty. Escape closes the dialog while the form still equals it and no photo is queued.
  const baselineRef = React.useRef<DraftFields>(form);
  const setFormProgrammatic = (update: (f: DraftFields) => DraftFields) => {
    baselineRef.current = update(baselineRef.current);
    setForm(update);
  };

  // Re-sync prefills whenever the modal (re)opens — covers both callers that
  // conditionally mount this component fresh (products page) and callers
  // that keep it mounted and just flip `isOpen` (the scan surfaces).
  React.useEffect(() => {
    if (!isOpen) return;
    setFormProgrammatic((f) => ({
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

  // Pre-populate fields from parent when a parent is selected. Keyed on the parent being FOUND, not only on its id:
  // the products page's "Add variant" mounts this modal with the parent id already set while the catalog is still
  // loading, and an id-only key ran once with nothing to read and never again (K11-27: Unit and Price stayed blank,
  // the browser refused the submit, and no toast could appear).
  const prefillParent = allProducts.find((p) => p.id === form.parentProductId);
  React.useEffect(() => {
    if (!form.parentProductId) return;
    const parent = prefillParent;
    if (!parent) return;
    // Fill only what the operator has not touched: a field that differs from the baseline is theirs (the catalog
    // can land after they started typing). Price and Units per box already keep any non-blank value.
    const base = baselineRef.current;
    setFormProgrammatic((f) => ({
      ...f,
      category: f.category === base.category ? (parent.category ?? f.category) : f.category,
      unit: f.unit === base.unit ? (parent.unit ?? f.unit) : f.unit,
      pricePerUnit: f.pricePerUnit || String(parseFloat(String(parent.pricePerUnit)).toFixed(2)),
      unitsPerBox: f.unitsPerBox || String(parent.unitsPerBox ?? ""),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.parentProductId, prefillParent?.id]);

  /** K12 O1: the pack size typed into the prompt and not yet confirmed there (null when none). */
  const pendingPackSizeRef = React.useRef<number | null>(null);
  const [priceError, setPriceError] = React.useState("");
  const [pieceError, setPieceError] = React.useState("");
  const [isSavingPiece, setIsSavingPiece] = React.useState(false);
  // K11-28: the piece price needs both units flags (the units POST and the S9 prices write are gated on them).
  const pricesV2 = usePricesV2Enabled();
  const unitsV1 = useUnitsEnabled();
  // K14 F03: shown as soon as a pack unit is picked (no parent: a variant is priced by its family), so the owner sees
  // it beside Units per box without typing first. Creating WITH a piece price still needs a whole Units per box of 2
  // or more (a factor-1 unit equal to the pack's is refused): submit checks `piecesPerPack`, not visibility.
  const piecesPerPack = /^\d+$/.test(form.unitsPerBox.trim()) ? Number(form.unitsPerBox) : 0;
  const showPiecePrice = pricesV2 && unitsV1 && isPackUnit(form.unit) && !form.parentProductId;
  // The cell appears one row below the field being typed in, possibly past the visible part of the scroll body (on a
  // phone, behind the pinned footer). Reveal it by the minimum scroll; focus stays where it is.
  const pieceCellRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (showPiecePrice) pieceCellRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [showPiecePrice]);
  const [pendingImages, setPendingImages] = React.useState<File[]>([]);
  const [previews, setPreviews] = React.useState<string[]>([]);
  const [isUploading, setIsUploading] = React.useState(false);
  const [variantOfScanLoading, setVariantOfScanLoading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const barcodeInputRef = React.useRef<HTMLInputElement>(null);
  const skuInputRef = React.useRef<HTMLInputElement>(null);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const unitSkuInputRef = React.useRef<HTMLInputElement>(null);

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

  // Regulated type + category pickers (both optional). The category list is
  // scoped to the chosen type and cleared when the type changes.
  const { data: sections = [] } = useTrackedCategories({ active: true });
  const sectionOptions = sectionPickerOptions(sections);

  // Regulatory reporting (Item type / UoM / Case UoM) — only rendered when the
  // selected section's reportTemplate resolves to a template with per-product
  // config (e.g. TX Comptroller). Static per deploy, so cached for the session.
  const { data: templates = [] } = useRegulatedTemplates();
  const selectedSection = sections.find((s) => s.id === form.trackedCategoryId);
  const productConfig: RegProductConfig | null =
    templates.find((t) => t.key === selectedSection?.reportTemplate)?.productConfig ?? null;

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
    setFormProgrammatic(() => ({ ...EMPTY_DRAFT_FORM }));
    setPendingImages([]);
    setPreviews([]);
  };

  // Unfinished-product draft: only a plain New product (no prefill, not a variant) keeps one.
  const draft = useProductCreateDraft({
    isOpen,
    enabled: [
      defaultParentId,
      initialName,
      initialSku,
      initialPrice,
      initialCost,
      initialUnitsPerBox,
    ].every((v) => v == null),
    form,
    onRestore: (fields) => setFormProgrammatic((f) => ({ ...f, ...fields })),
  });

  /**
   * K11-28 (design gate B2): add the 1-piece "Piece" unit WITHOUT a price (the server names every factor-1 unit
   * "Piece"), read the grid's revision and price state, then set the Piece's Retail price through S9. Each step
   * throws on failure and nothing follows a failed step.
   */
  const savePiecePrice = async (productId: string, to: number) => {
    await apiClient.post(`/products/${productId}/units`, { label: "Piece", factorToBase: 1 });
    const grid = await fetchPriceGrid(productId);
    const body: SavePricesRequest = {
      expectedRevision: grid.revision,
      expectedPriceState: grid.priceState,
      patches: [{ ref: "base", tier: 1, to }],
    };
    await apiClient.post(`/products/${productId}/prices`, body);
  };

  // In-flight guard: a double-click posts twice (201 then 409) before isPending re-renders.
  const submittingRef = React.useRef(false);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await submitProduct();
    } finally {
      submittingRef.current = false;
    }
  };

  const submitProduct = async () => {
    if (!form.pricePerUnit || parseFloat(form.pricePerUnit) < 0) {
      setPriceError("Please enter a valid price.");
      return;
    }
    setPriceError("");
    // K11-28: a bad piece price blocks Create BEFORE anything is written (validateSetPrice is the one rule).
    let pieceTo: number | null = null;
    if (showPiecePrice && form.pricePerPiece.trim() !== "") {
      if (piecesPerPack < 2) {
        setPieceError(
          `Enter Units per ${w.pack.lower} (2 or more) to price a single ${w.base.lower}.`,
        );
        return;
      }
      const checked = validateSetPrice(form.pricePerPiece);
      if (!checked.ok) {
        setPieceError(checked.message);
        return;
      }
      pieceTo = checked.value;
    }
    setPieceError("");
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
        barcode: form.barcode.trim() || undefined,
        unitSku: form.unitSku.trim() || undefined,
        unit: form.unit,
        pricePerUnit: form.pricePerUnit,
        // One category axis: a regulated type's structured Category picker
        // drives `category` server-side — never send the free-text value
        // (which is hidden/cleared in the form) when a type is selected.
        category: form.trackedCategoryId ? undefined : form.category || undefined,
        description: form.description || undefined,
        costingMethod: form.costingMethod || "AVCO",
        standardCost:
          form.costingMethod === "STANDARD" && form.standardCost ? form.standardCost : undefined,
        // K12 O1: a count typed into the pack-size prompt but not confirmed there is still sent, never dropped.
        unitsPerBox: form.unitsPerBox
          ? parseInt(form.unitsPerBox, 10)
          : (pendingPackSizeRef.current ?? undefined),
        parentProductId: form.parentProductId || undefined,
        variantName: form.variantName || undefined,
        trackedCategoryId: form.trackedCategoryId || undefined,
        trackedSubcategoryId: form.trackedSubcategoryId || undefined,
        regItemType: form.regItemType || undefined,
        regUomCase: form.regUomCase || undefined,
        regUomUnit: form.regUomUnit || undefined,
      });
      draft.clear();
    } catch (err: any) {
      // Only the formula-led refusal is ours; any other error already reached the global toast.
      const copy = safeTextErrorCopy(err);
      if (copy) toast({ title: "Failed to create product", description: copy, variant: "error" });
      return;
    }

    // K11-28: the optional piece price, after the product exists. Three separate writes, the price through S9
    // (compare-and-set, audit, undo), never on the units POST. Any failure keeps the product and stops the chain.
    let pieceFailed = false;
    let photosFailed = false;
    if (pieceTo != null && product?.id) {
      setIsSavingPiece(true);
      try {
        await savePiecePrice(product.id, pieceTo);
      } catch {
        pieceFailed = true;
      } finally {
        setIsSavingPiece(false);
      }
    }

    // Upload images if any were queued
    if (pendingImages.length > 0 && product?.id) {
      setIsUploading(true);
      try {
        await uploadProductImages(product.id, pendingImages);
      } catch {
        // The product EXISTS now: say the photos missed, hand the product back, and close (a retry here would duplicate it).
        photosFailed = true;
      } finally {
        setIsUploading(false);
      }
    }
    // K11-27: exactly one toast per create, held long enough to read. Any failure above becomes ONE warning
    // (naming everything that missed) in place of the success toast.
    if (pieceFailed && photosFailed) {
      toast({
        title: `Product created, but its ${w.base.lower} price and photos weren't saved. Set them on the product page.`,
        variant: "warning",
        duration: CREATED_TOAST_MS,
      });
    } else if (pieceFailed) {
      toast({
        title: `Product created, but its ${w.base.lower} price wasn't saved. Set it on the product page.`,
        variant: "warning",
        duration: CREATED_TOAST_MS,
      });
    } else if (photosFailed) {
      toast({
        title: "Product created, but its photos didn't upload",
        description: "Add them from the product page.",
        variant: "warning",
        duration: CREATED_TOAST_MS,
      });
    } else {
      const parentName = product?.parent?.name ?? prefillParent?.name;
      toast({
        title:
          form.parentProductId && form.variantName.trim()
            ? parentName
              ? `${productName} added to ${parentName}`
              : `${productName} added`
            : `${product?.name || productName} created`,
        variant: "success",
        duration: CREATED_TOAST_MS,
      });
    }

    onCreated(product);
    onClose();
    resetForm();
  };

  if (!isOpen) return null;

  const busy = createProduct.isPending || isUploading || isSavingPiece;
  const pristine =
    pendingImages.length === 0 &&
    (Object.keys(EMPTY_DRAFT_FORM) as (keyof DraftFields)[]).every(
      (k) => form[k] === baselineRef.current[k],
    );

  const packUnit = isPackUnit(form.unit);
  const unitWord = priceUnitWord(form.unit);
  const qtyHint = packUnit
    ? priceQtyHint({
        price: form.pricePerUnit,
        unitsPerBox: form.unitsPerBox,
        packWord: w.pack.lower,
      })
    : null;
  const unitsPerField = (
    <div>
      <label htmlFor="product-units-per" className="mb-1 block text-sm font-medium text-navy">
        {`Units per ${w.pack.lower}`}
      </label>
      <input
        id="product-units-per"
        type="number"
        min="1"
        step="1"
        placeholder="e.g. 12"
        value={form.unitsPerBox}
        onChange={(e) => set("unitsPerBox", e.target.value)}
        className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      <p className="mt-0.5 text-xs text-navy/70">
        How many individual units are in one {w.pack.lower} (optional)
      </p>
      {validUnitsPerBoxPrefill(initialUnitsPerBox) &&
        form.unitsPerBox === String(initialUnitsPerBox) && (
          <p className="mt-0.5 text-[11px] text-navy/70">
            Suggested from the invoice line ({initialUnitsPerBox} per {w.pack.lower}) — verify
            before saving.
          </p>
        )}
    </div>
  );

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="New product"
      scroll
      className="max-w-lg"
      // Pinned to the top, fade-in only: rows that change height must not recentre the form.
      anchor="top"
      // A long form: an outside click never closes it. Escape closes it only while it is pristine (nothing
      // typed, no photo queued), and never when it was meant for an open list (Unit, Category).
      onEscapeKeyDown={(e) => {
        if (!pristine || listOpenInDialog(e.target)) e.preventDefault();
      }}
      onInteractOutside={(e) => e.preventDefault()}
      // Focus lands on the first thing to type (Flavor when a parent is set), not on the X.
      onOpenAutoFocus={(e) => {
        const first =
          document.getElementById("product-variant-name") ??
          document.getElementById("product-name");
        if (!first) return;
        e.preventDefault();
        first.focus();
      }}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} loading={busy}>
            {isUploading ? "Uploading photos…" : "Create product"}
          </Button>
        </>
      }
    >
      {/* pb-20: the last field (and an open Category list) clears the pinned footer, which is ~75 px tall */}
      <form
        id={FORM_ID}
        onSubmit={handleSubmit}
        // K14 F14: the field being typed (and the piece price) scrolls in with footer-sized room below it
        className="pb-20 [&_input]:scroll-mb-24"
      >
        <div className="space-y-4">
          {draft.offer && (
            <RestoreDraftBanner
              onRestore={draft.restore}
              onDiscard={() => {
                draft.discard();
                setFormProgrammatic((f) => ({ ...f, ...EMPTY_DRAFT_FORM }));
              }}
            />
          )}
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
            {/* Variant of — optional parent selector. Always mounted (reserved size): the catalog
                  behind it loads after the first paint and must not push the Name field down; the
                  picker is disabled until there is a standalone product to pick. */}
            <div data-reserved-row="variant-of" className={`col-span-2 ${RESERVED_ROW}`}>
              <label className="mb-1 block text-sm font-medium text-navy">
                Variant of <span className="font-normal text-navy/70">(optional)</span>
              </label>
              <div className="flex items-stretch gap-2">
                <SearchableProductPicker
                  value={form.parentProductId}
                  onChange={(id) => set("parentProductId", id)}
                  products={parentCandidates}
                  disabled={parentCandidates.length === 0}
                  disabledHint={noProductsYet ? "Add a product first to make variants." : ""}
                  emptyHint="No standalone products yet."
                  placeholder="Standalone product (type to search)…"
                  className="flex-1"
                />
                <BarcodeScannerButton
                  onScan={handleVariantOfScan}
                  title="Scan a variant's barcode to auto-select its parent"
                  disabled={noProductsYet}
                  ariaLabel={
                    noProductsYet
                      ? "Scan a variant (add a product first to make variants)"
                      : undefined
                  }
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
            {form.parentProductId && (
              <div className="col-span-2">
                <label className="mb-1 block text-sm font-medium text-navy">
                  Flavor / variety <span className="text-danger">*</span>
                </label>
                <input
                  id="product-variant-name"
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
                <label htmlFor="product-name" className="mb-1 block text-sm font-medium text-navy">
                  Name *
                </label>
                <input
                  id="product-name"
                  required
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            )}
            <div className="col-span-2">
              <label htmlFor="product-barcode" className="mb-1 block text-sm font-medium text-navy">
                Barcode
              </label>
              <div className="flex gap-2">
                <input
                  id="product-barcode"
                  ref={barcodeInputRef}
                  value={form.barcode}
                  onChange={(e) => set("barcode", e.target.value)}
                  className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Scan or enter the barcode"
                />
                <BarcodeScannerButton
                  inputRef={barcodeInputRef}
                  onScan={(code) => set("barcode", code)}
                  title="Scan barcode"
                />
              </div>
            </div>
            <div className="col-span-2">
              <label htmlFor="product-sku" className="mb-1 block text-sm font-medium text-navy">
                {`SKU (${w.pack.lower} code)`}
              </label>
              <div className="flex gap-2">
                <input
                  id="product-sku"
                  ref={skuInputRef}
                  value={form.sku}
                  onChange={(e) => set("sku", e.target.value)}
                  className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Scan or enter the SKU"
                />
                <BarcodeScannerButton
                  inputRef={skuInputRef}
                  onScan={(code) => set("sku", code)}
                  title="Scan SKU"
                />
              </div>
            </div>

            <div className="col-span-2">
              <label
                htmlFor="product-unit-sku"
                className="mb-1 block text-sm font-medium text-navy"
              >
                Unit code
              </label>
              <div className="flex gap-2">
                <input
                  id="product-unit-sku"
                  ref={unitSkuInputRef}
                  value={form.unitSku}
                  onChange={(e) => set("unitSku", e.target.value)}
                  className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Scan or enter the unit's own code"
                />
                <BarcodeScannerButton
                  inputRef={unitSkuInputRef}
                  onScan={(code) => set("unitSku", code)}
                  title="Scan unit code"
                />
              </div>
              <p className="mt-0.5 text-xs text-navy/70">
                Printed on invoices. Leave blank if it&apos;s the same as the {w.pack.lower} code.
              </p>
            </div>

            {/* Unit — combobox (pick from list OR type a custom value) */}
            <div>
              <label htmlFor="product-unit" className="mb-1 block text-sm font-medium text-navy">
                Unit *
              </label>
              <UnitCombobox
                id="product-unit"
                required
                value={form.unit}
                onChange={(v) => set("unit", v)}
                extraUnits={units}
              />
            </div>

            <div
              data-price-row
              className={packUnit ? "col-span-2 grid grid-cols-2 items-start gap-4" : undefined}
            >
              <div>
                <label htmlFor="product-price" className="mb-1 block text-sm font-medium text-navy">
                  {`Price per ${unitWord} *`}
                </label>
                <div className="flex items-center">
                  <span className="flex h-[38px] items-center rounded-l border border-r-0 border-surface-border bg-surface-raised px-2.5 text-sm text-navy/70">
                    $
                  </span>
                  <input
                    id="product-price"
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    aria-describedby={qtyHint ? "price-qty-hint" : undefined}
                    value={form.pricePerUnit}
                    onChange={(e) => {
                      set("pricePerUnit", e.target.value);
                      setPriceError("");
                    }}
                    className={`w-full rounded-r border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 ${priceError ? "border-danger focus:ring-danger" : "border-surface-border"}`}
                  />
                </div>
                {priceError && <p className="mt-1 text-xs text-danger">{priceError}</p>}
                <p
                  id="price-qty-hint"
                  aria-live="polite"
                  className="mt-1 text-xs text-navy/70 empty:hidden"
                >
                  {qtyHint}
                </p>
                {initialCost != null && initialCost > 0 && (
                  <p className="mt-1 text-[11px] text-navy/70">
                    {validUnitsPerBoxPrefill(initialUnitsPerBox)
                      ? `Suggested from the invoice case cost + 30%; cost saved per unit ($${initialCost.toFixed(2)}). `
                      : `Suggested from invoice cost $${initialCost.toFixed(2)} + 30%. `}
                    For FIFO/AVCO products the actual cost is recorded when the bill is received.
                  </p>
                )}
              </div>
              {packUnit && unitsPerField}
              {showPiecePrice && (
                <div ref={pieceCellRef} className="scroll-mb-24">
                  <label
                    htmlFor="product-base-price"
                    className="mb-1 block text-sm font-medium text-navy"
                  >
                    Price per {w.base.lower}{" "}
                    <span className="font-normal text-navy/70">(optional)</span>
                  </label>
                  <div className="flex items-center">
                    <span className="flex h-[38px] items-center rounded-l border border-r-0 border-surface-border bg-surface-raised px-2.5 text-sm text-navy/70">
                      $
                    </span>
                    <input
                      id="product-base-price"
                      type="number"
                      step="any"
                      placeholder="0.00"
                      aria-invalid={pieceError ? "true" : undefined}
                      aria-describedby={
                        pieceError ? "base-price-help base-price-error" : "base-price-help"
                      }
                      value={form.pricePerPiece}
                      onChange={(e) => {
                        set("pricePerPiece", e.target.value);
                        setPieceError("");
                      }}
                      className={`w-full rounded-r border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 ${pieceError ? "border-danger focus:ring-danger" : "border-surface-border"}`}
                    />
                  </div>
                  {pieceError && (
                    <p id="base-price-error" className="mt-1 text-xs text-danger">
                      {pieceError}
                    </p>
                  )}
                  <p id="base-price-help" className="mt-1 text-xs text-navy/70">
                    Leave blank to sell only by the {w.pack.lower}.
                  </p>
                </div>
              )}
            </div>

            {/* Category — ONE axis. Free-text for non-regulated products;
                  once a regulated type is chosen this slot switches to that
                  type's structured, type-ahead Category picker instead. */}
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium text-navy">Category</label>
              {form.trackedCategoryId ? (
                <>
                  <SubcategoryCombobox
                    sectionId={form.trackedCategoryId || null}
                    value={form.trackedSubcategoryId}
                    onChange={(id) => set("trackedSubcategoryId", id)}
                  />
                  <p className="mt-0.5 text-xs text-navy/70">
                    Categories for this regulated type — type to create.
                  </p>
                </>
              ) : (
                <CategoryCombobox
                  value={form.category}
                  onChange={(v) => set("category", v)}
                  placeholder="Select or type a new category"
                />
              )}
            </div>

            {/* Regulated type (optional) — see /settings?tab=regulated */}
            {sectionOptions.length > 0 && (
              <div className="col-span-2">
                <label className="mb-1 block text-sm font-medium text-navy">Regulated type</label>
                <select
                  value={form.trackedCategoryId}
                  onChange={(e) => {
                    const trackedCategoryId = e.target.value;
                    setForm((f) => ({
                      ...f,
                      trackedCategoryId,
                      trackedSubcategoryId: "",
                      // Selecting a type replaces the free-text Category
                      // field with the structured combobox above — clear any
                      // typed value so a stale one can't be submitted.
                      category: trackedCategoryId ? "" : f.category,
                      // Regulatory reporting config is scoped to the
                      // section's report template — clear it whenever the
                      // section changes (including cleared entirely) so a
                      // stale code from a different vocabulary can never be
                      // submitted.
                      regItemType: "",
                      regUomCase: "",
                      regUomUnit: "",
                    }));
                  }}
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
            )}

            {/* Regulatory reporting (per-product) — Item type / Unit of measure /
                  Case unit of measure. Gated on the section's report template
                  needing per-product config (e.g. TX Comptroller). */}
            {productConfig && (
              <div className="col-span-2 space-y-3 rounded-lg border border-surface-border bg-surface-raised/40 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-navy/60">
                  Regulatory reporting
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-navy">Item type</label>
                    <select
                      value={form.regItemType}
                      onChange={(e) => {
                        const regItemType = e.target.value;
                        setForm((f) => {
                          const validUoms = uomsForItemType(productConfig, regItemType).map(
                            (u) => u.code,
                          );
                          return {
                            ...f,
                            regItemType,
                            regUomUnit: validUoms.includes(f.regUomUnit) ? f.regUomUnit : "",
                            regUomCase: validUoms.includes(f.regUomCase) ? f.regUomCase : "",
                          };
                        });
                      }}
                      className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      <option value="">Select…</option>
                      {productConfig.itemTypes.map((t) => (
                        <option key={t.code} value={t.code}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-navy">
                      Unit of measure (per {w.base.lower})
                    </label>
                    <select
                      value={form.regUomUnit}
                      onChange={(e) => set("regUomUnit", e.target.value)}
                      disabled={!form.regItemType}
                      className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-raised disabled:text-navy/40"
                    >
                      <option value="">
                        {form.regItemType ? "Select…" : "Select item type first"}
                      </option>
                      {uomsForItemType(productConfig, form.regItemType).map((u) => (
                        <option key={u.code} value={u.code}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {productConfig.caseUomSupported && Number(form.unitsPerBox) > 1 && (
                    <div className="col-span-2">
                      <label className="mb-1 block text-sm font-medium text-navy">
                        Case unit of measure
                      </label>
                      <select
                        value={form.regUomCase}
                        onChange={(e) => set("regUomCase", e.target.value)}
                        disabled={!form.regItemType}
                        className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-raised disabled:text-navy/40"
                      >
                        <option value="">
                          {form.regItemType ? "Select…" : "Select item type first"}
                        </option>
                        {uomsForItemType(productConfig, form.regItemType).map((u) => (
                          <option key={u.code} value={u.code}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                      <p className="mt-0.5 text-xs text-navy/70">
                        Used when this product is sold by the case. Leave blank to report every
                        quantity in {w.base.lowerOther}.
                      </p>
                    </div>
                  )}
                </div>
              </div>
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
              <label className="mb-1 block text-sm font-medium text-navy">Costing method</label>
              <select
                value={form.costingMethod}
                onChange={(e) => set("costingMethod", e.target.value)}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="AVCO">AVCO — Weighted Average Cost</option>
                <option value="LAST_COST">Last Cost — most recent purchase price</option>
                <option value="STANDARD">Standard Cost</option>
              </select>
            </div>

            {form.costingMethod === "STANDARD" && (
              <div>
                <label className="mb-1 block text-sm font-medium text-navy">Standard Cost *</label>
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

            {!packUnit && unitsPerField}

            {/* Pack-size prompt — suggested from the name/unit while the field
                  above is still unset. Never guesses: HIGH/MEDIUM pre-fills the
                  parsed count, AMBIGUOUS states the conflict and leaves the input
                  empty, PIECE_UNIT renders nothing. `/products/create` is only a
                  redirect to this modal (RF-203), so this IS the web create form. */}
            {/* `col-span-2` goes on the component itself, not a wrapper: the
                  prompt renders null most of the time and an empty wrapper would
                  still cost a grid row of `gap-4`. */}
            <PackSizePrompt
              className="col-span-2"
              // Mirrors the submit-time name resolution above: a variant is
              // created under its own `variantName`, not the blank name field.
              name={form.parentProductId && form.variantName.trim() ? form.variantName : form.name}
              unit={form.unit}
              unitSku={form.unitSku}
              unitsPerBox={form.unitsPerBox}
              onAccept={(value) => set("unitsPerBox", String(value))}
              onPendingChange={(value) => {
                pendingPackSizeRef.current = value;
              }}
            />
          </div>
        </div>
        {/* K14 P16: a short fade over the last rows, so a scrolled form ends soft, not in a flat cut at the footer */}
        <div
          data-scroll-fade
          aria-hidden="true"
          className="pointer-events-none sticky bottom-0 -mb-20 h-6 bg-gradient-to-t from-white to-transparent"
        />
      </form>
    </Modal>
  );
}
