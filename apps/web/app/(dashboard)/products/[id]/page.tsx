"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Package,
  Pencil,
  Check,
  X,
  Upload,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Star,
  Scissors,
  Plus,
  Power,
  ShieldCheck,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, Modal, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import {
  useProduct,
  useProducts,
  useUpdateProduct,
  useDeleteProduct,
  useUploadProductImages,
  useDeleteProductImage,
  useCreateProduct,
  type ApiProduct,
} from "@/lib/api/products";
import { useCostHistory } from "@/lib/api/cost-history";
import {
  useTrackedCategories,
  useRegulatedTemplates,
  type ReportTemplateDef,
} from "@/lib/api/tracked-categories";
import { sectionPickerOptions } from "@/lib/regulated-format";
import { getTierPrice, cascadeTierPrices, perUnitPrice, type TierField } from "@/lib/pricing";
import { useTierLabels } from "@/lib/api/tier-labels";
import { tierLabel } from "@/lib/tier-label";
import { unitsLabel } from "@/lib/stock-label";
import { apiClient } from "@/lib/api-client";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DecimalInput } from "@/components/MoneyInput";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import { SubcategoryCombobox } from "@/components/SubcategoryCombobox";
import { SetCostModal } from "@/components/SetCostModal";
import { VariantSplitModal } from "@/components/VariantSplitModal";
import { PackSizePrompt } from "@/components/PackSizePrompt";
import { useAuth } from "@/lib/auth-context";
import { useHasAddon, TOBACCO_ADDON } from "@/lib/api/tobacco";
import { MSRP_ADDON } from "@/lib/api/addons";
import { CropModal } from "./CropModal";
import { DemandCard } from "./DemandCard";
import { SalesHistoryCard } from "./SalesHistoryCard";
import { ImageLightbox } from "./ImageLightbox";
import { objectPositionForUrl, type FocalPoint } from "@/lib/image-focal";

const COMMON_UNITS = [
  "unit",
  "each",
  "case",
  "box",
  "bag",
  "pack",
  "dozen",
  "pallet",
  "kg",
  "g",
  "lb",
  "oz",
  "L",
  "ml",
  "tray",
  "bottle",
  "can",
  "roll",
  "sheet",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

type StockStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";

function getStockStatus(currentStock: number, isActive: boolean): StockStatus {
  if (!isActive) return "OUT_OF_STOCK";
  if (currentStock <= 0) return "OUT_OF_STOCK";
  if (currentStock <= 5) return "LOW";
  return "IN_STOCK";
}

// ─── Info row ─────────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">{label}</p>
      <div className="mt-1 text-sm font-medium text-navy">{value}</div>
    </div>
  );
}

// ─── Regulatory reporting (per-product Item Type / UoM) ────────────────────

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

/** Human label for an item-type code; the raw code (or an em dash) when unresolved. */
function regItemTypeLabel(
  productConfig: RegProductConfig | null,
  code: string | null | undefined,
): React.ReactNode {
  if (!code) return <span className="text-navy/30">—</span>;
  return productConfig?.itemTypes.find((t) => t.code === code)?.label ?? code;
}

/** Human label for a UoM code (searched across all item types); the raw code when unresolved. */
function regUomLabel(
  productConfig: RegProductConfig | null,
  code: string | null | undefined,
): React.ReactNode {
  if (!code) return <span className="text-navy/30">—</span>;
  for (const t of productConfig?.itemTypes ?? []) {
    const match = t.uoms.find((u) => u.code === code);
    if (match) return match.label;
  }
  return code;
}

// ─── Merchandising flag toggle (P5-01) ──────────────────────────────────────────

function MerchFlagToggle({
  label,
  description,
  active,
  disabled,
  onToggle,
}: {
  label: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
        active
          ? "border-brand-300 bg-brand-50"
          : "border-surface-border bg-white hover:bg-surface-raised",
      )}
    >
      <span className="min-w-0">
        <span className={cn("block text-sm font-medium", active ? "text-brand-700" : "text-navy")}>
          {label}
        </span>
        <span className="block text-[11px] text-navy/60">{description}</span>
      </span>
      <span
        className={cn(
          "relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors",
          active ? "bg-brand-500" : "bg-navy/20",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
            active ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

// ─── Inline number field ──────────────────────────────────────────────────────
// Thin wrapper over DecimalInput so price/tier fields never reformat while
// typing (the old numeric-bound input ate decimal points mid-keystroke).

function EditableNumber({
  value,
  onChange,
  onCommit,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  return (
    <DecimalInput
      min={0}
      value={Number.isFinite(value) ? value : null}
      onChange={(v) => onChange(v ?? 0)}
      onCommit={onCommit}
      className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
    />
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function CostHistoryCard({ productId }: { productId: string }) {
  const { data: history = [] } = useCostHistory(productId);

  if (history.length === 0) return null;

  const chartData = history.map((h) => ({
    date: new Date(h.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    purchaseCost: h.unitCost,
    avgCost: h.avgCostAfter,
    type: h.type,
  }));

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
      <div className="border-b border-surface-border px-5 py-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Purchase Cost History
        </h3>
      </div>
      <div className="p-5">
        <p className="mb-3 text-xs text-navy/70">
          Unit cost of each purchase (and manual cost-basis entries) with the running average cost.
        </p>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "#1B3A5C99" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "#1B3A5C99" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `$${v}`}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #e2e8f0",
                fontSize: 12,
                boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
              }}
              labelStyle={{ color: "#1B3A5C", fontWeight: 600 }}
              formatter={
                ((v: number, name: string) => [
                  `$${Number(v).toFixed(4)}`,
                  name === "purchaseCost" ? "Purchase cost" : "Avg cost after",
                ]) as any
              }
            />
            <Line
              type="stepAfter"
              dataKey="avgCost"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="purchaseCost"
              stroke="#f59e0b"
              strokeWidth={0}
              dot={{ r: 3, fill: "#f59e0b" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const { data: product, isLoading } = useProduct(params.id);
  const { data: allProductsResult } = useProducts({ limit: 0 });
  const { data: tierLabels } = useTierLabels();
  const updateProduct = useUpdateProduct();
  const createProduct = useCreateProduct();
  const deleteProduct = useDeleteProduct();
  const uploadImages = useUploadProductImages(params.id);
  const deleteImage = useDeleteProductImage(params.id);

  const [isEditing, setIsEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState<Record<string, unknown>>({});

  // Regulated type picker (edit mode). The Category field below renders the
  // structured SubcategoryCombobox in place of the free-text combobox once a
  // type is selected, which fetches/scopes its own options.
  const { data: regulatedSections = [] } = useTrackedCategories({ active: true });
  // Keeps a since-deactivated current section selectable (labelled inactive) so
  // an edit never silently drops a still-applied tag — shared with the create
  // modal so the rule can't drift.
  const sectionOptions = sectionPickerOptions(regulatedSections, product?.trackedCategory);

  // Regulatory reporting (Item type / UoM / Case UoM) — only rendered when the
  // relevant section's reportTemplate resolves to a template with per-product
  // config (e.g. TX Comptroller). Resolved off the draft's selected section
  // while editing (so switching Regulated type updates the block live), off
  // the product's current section otherwise.
  const { data: reportTemplates = [] } = useRegulatedTemplates();
  const regTemplateForSection = (sectionId: string | null | undefined) => {
    const section = regulatedSections.find((s) => s.id === sectionId);
    return reportTemplates.find((t) => t.key === section?.reportTemplate);
  };
  const activeProductConfig: RegProductConfig | null = isEditing
    ? (regTemplateForSection(editDraft.trackedCategoryId as string)?.productConfig ?? null)
    : (regTemplateForSection(product?.trackedCategory?.id)?.productConfig ?? null);
  const activeUnitsPerBox = isEditing
    ? Number.parseFloat((editDraft.unitsPerBox as string) || "0") || 0
    : Number(product?.unitsPerBox ?? 0);
  // Whether a regulated type is currently chosen — draft while editing (so
  // clearing the type immediately stops the Regulatory reporting card claiming
  // a template), the saved product otherwise. Same edit/read split as
  // `activeProductConfig`, and they must stay in sync.
  const hasActiveRegType = isEditing
    ? !!(editDraft.trackedCategoryId as string)
    : !!product?.trackedCategoryId;
  const [activeImageIdx, setActiveImageIdx] = React.useState(0);
  const [isDragging, setIsDragging] = React.useState(false);
  const [selectedImages, setSelectedImages] = React.useState<Set<number>>(new Set());
  const [selectMode, setSelectMode] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // ── Variant modal state ──────────────────────────────────────────────────
  const [variantModalOpen, setVariantModalOpen] = React.useState(false);
  const [editingVariant, setEditingVariant] = React.useState<ApiProduct | null>(null);
  const [variantForm, setVariantForm] = React.useState({
    variantName: "",
    sku: "",
    unitSku: "",
    price: "",
    unit: "",
    priceTier2: "",
    priceTier3: "",
    priceTier4: "",
    priceTier5: "",
  });
  const variantSkuRef = React.useRef<HTMLInputElement>(null);
  const variantUnitSkuRef = React.useRef<HTMLInputElement>(null);

  // ── "Make variant of" modal state ────────────────────────────────────────
  const [makeVariantOpen, setMakeVariantOpen] = React.useState(false);
  const [makeVariantParentId, setMakeVariantParentId] = React.useState("");
  const [makeVariantName, setMakeVariantName] = React.useState("");
  const [makeVariantScanLoading, setMakeVariantScanLoading] = React.useState(false);
  const [makeVariantParentOwnName, setMakeVariantParentOwnName] = React.useState("");

  // ── "Link existing product as variant" modal state ──────────────────────
  const [linkExistingOpen, setLinkExistingOpen] = React.useState(false);
  const [linkExistingProductId, setLinkExistingProductId] = React.useState("");
  const [linkExistingVariantName, setLinkExistingVariantName] = React.useState("");
  const [linkExistingParentVariantName, setLinkExistingParentVariantName] = React.useState("");
  const [linkExistingSearch, setLinkExistingSearch] = React.useState("");

  // ── Auth ──────────────────────────────────────────────────────────────────
  const { user } = useAuth();
  const isOperator = user?.role === "OPERATOR";
  const hasTobaccoAddon = useHasAddon(TOBACCO_ADDON);
  const hasMsrpAddon = useHasAddon(MSRP_ADDON);

  // ── Lightbox state ────────────────────────────────────────────────────────
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const [lightboxIdx, setLightboxIdx] = React.useState(0);

  // ── Set-cost modal state ──────────────────────────────────────────────────
  const [showCostModal, setShowCostModal] = React.useState(false);

  // ── Variant-split modal state (PR-D) ──────────────────────────────────────
  const [showVariantSplit, setShowVariantSplit] = React.useState(false);

  // ── Delete confirmation (R2 — was declared, never wired) ──────────────────
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

  // ── Crop-existing state ───────────────────────────────────────────────────
  // When set, the next crop completion replaces this key instead of adding a new image
  const [cropExistingKey, setCropExistingKey] = React.useState<string | null>(null);

  // ── Crop-before-upload state ──────────────────────────────────────────────
  // When the user picks files we queue them here; CropModal works through them
  // one-by-one (crop → focal point per file). Once the queue is empty the
  // cropped blobs and their focal points are uploaded together.
  const [cropState, setCropState] = React.useState<{
    queue: File[];
    accumulated: Array<{ blob: Blob; focal: FocalPoint }>;
  } | null>(null);

  // Derived: all known units from the catalog (categories come from CategoryCombobox's own fetch)
  const allProducts: any[] = allProductsResult?.data ?? [];
  const catalogUnits = Array.from(
    new Set([...COMMON_UNITS, ...allProducts.map((p: any) => p.unit).filter(Boolean)]),
  ).sort() as string[];

  // Standalone products eligible as parents in the "Variant of" edit dropdown
  const variantOfCandidates = allProducts.filter(
    (p: any) => !p.parentProductId && p.id !== params.id,
  );

  // Reset active image index if images change
  React.useEffect(() => {
    setActiveImageIdx(0);
  }, [product?.id]);

  React.useEffect(() => {
    setTitle(product?.name ?? "Product");
  }, [setTitle, product?.name]);

  if (isLoading) {
    return <div className="flex items-center justify-center p-12 text-navy/70">Loading...</div>;
  }

  if (!product) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Product not found.</p>
        <Button variant="secondary" href="/products">
          Back to Products
        </Button>
      </div>
    );
  }

  const priceNumber = parseFloat(String(product.pricePerUnit));
  const currentStock = Number(product.currentStock ?? 0);
  const stockStatus = getStockStatus(currentStock, product.isActive);

  // MSRP — display-only, never money math. Warn (non-blocking) when it undercuts
  // the wholesale price expressed per PIECE (pricePerUnit / unitsPerBox), which is
  // the same comparison basis MSRP is always displayed in.
  const msrpNumber = isEditing
    ? (editDraft.msrp as string)?.trim()
      ? parseFloat(editDraft.msrp as string)
      : null
    : product.msrp != null
      ? Number(product.msrp)
      : null;
  const wholesaleListPrice = isEditing
    ? parseFloat(String(editDraft.pricePerUnit ?? priceNumber))
    : priceNumber;
  const wholesaleUnitsPerBox = isEditing
    ? parseFloat((editDraft.unitsPerBox as string) || "0") || 0
    : Number(product.unitsPerBox ?? 0);
  const wholesalePerPiece =
    wholesaleUnitsPerBox > 1 ? wholesaleListPrice / wholesaleUnitsPerBox : wholesaleListPrice;
  const msrpBelowWholesale =
    msrpNumber != null && wholesalePerPiece > 0 && msrpNumber < wholesalePerPiece;

  const startEdit = () => {
    setEditDraft({
      name: product.name,
      sku: product.sku ?? "",
      unitSku: product.unitSku ?? "",
      unit: product.unit,
      pricePerUnit: String(priceNumber),
      priceTier2: String(parseFloat(String(product.priceTier2 ?? priceNumber))),
      priceTier3: String(parseFloat(String(product.priceTier3 ?? priceNumber))),
      priceTier4: String(parseFloat(String(product.priceTier4 ?? priceNumber))),
      priceTier5: String(parseFloat(String(product.priceTier5 ?? priceNumber))),
      msrp: product.msrp != null ? String(parseFloat(String(product.msrp))) : "",
      category: product.category ?? "",
      description: product.description ?? "",
      parentProductId: product.parentProductId ?? "",
      variantName: product.variantName ?? "",
      trackedCategoryId: product.trackedCategory?.id ?? "",
      trackedSubcategoryId: product.trackedSubcategory?.id ?? "",
      regItemType: product.regItemType ?? "",
      regUomCase: product.regUomCase ?? "",
      regUomUnit: product.regUomUnit ?? "",
      unitsPerBox: product.unitsPerBox != null ? String(product.unitsPerBox) : "",
    });
    setIsEditing(true);
  };

  const saveEdit = () => {
    const draft = editDraft as Record<string, string>;
    const selectedParent = draft.parentProductId
      ? allProducts.find((p: any) => p.id === draft.parentProductId)
      : null;
    const composedName =
      selectedParent && draft.variantName?.trim()
        ? `${(selectedParent as any).name} - ${draft.variantName.trim()}`
        : (draft.name as string);

    // Build the PATCH explicitly — spreading the raw draft used to send
    // parentProductId: "" for every standalone product, which @IsUUID rejects,
    // so saving from this form (tier prices included) silently 400'd.
    // Invalid/blank price fields are omitted (leave unchanged), never "".
    const asDecimal = (v: unknown): string | undefined => {
      const n = parseFloat(String(v ?? ""));
      return Number.isFinite(n) && n >= 0 ? String(n) : undefined;
    };
    updateProduct.mutate(
      {
        id: params.id,
        name: composedName,
        unit: draft.unit || undefined,
        sku: draft.sku?.trim() || null,
        unitSku: draft.unitSku?.trim() || null,
        // One category axis: a regulated type's structured Category picker
        // drives `category` server-side — never send the free-text value
        // when a type is set. Clearing the type keeps the existing
        // null-clears semantics.
        category: draft.trackedCategoryId ? undefined : draft.category?.trim() || null,
        description: draft.description?.trim() || null,
        pricePerUnit: asDecimal(draft.pricePerUnit),
        priceTier2: asDecimal(draft.priceTier2),
        priceTier3: asDecimal(draft.priceTier3),
        priceTier4: asDecimal(draft.priceTier4),
        priceTier5: asDecimal(draft.priceTier5),
        unitsPerBox: draft.unitsPerBox?.trim() ? parseInt(draft.unitsPerBox, 10) : null,
        // Regulated tags: value to set, null to clear (server auto-nulls the
        // category when the type is cleared).
        trackedCategoryId: draft.trackedCategoryId || null,
        trackedSubcategoryId: draft.trackedSubcategoryId || null,
        // Regulatory reporting config: value to set, explicit null to clear.
        regItemType: draft.regItemType || null,
        regUomCase: draft.regUomCase || null,
        regUomUnit: draft.regUomUnit || null,
        // MSRP: only ever include the key when the tenant has the addon — the
        // server 403s any PATCH where `msrp` is *present* (even unchanged) for a
        // tenant without flag.msrp, which would otherwise block ordinary product
        // edits for a product that carries a stale MSRP from before the addon
        // was disabled. Explicit null clears (same "" → null convention as sku).
        ...(hasMsrpAddon
          ? { msrp: draft.msrp?.trim() ? String(parseFloat(draft.msrp)) : null }
          : {}),
        ...(draft.parentProductId
          ? {
              parentProductId: draft.parentProductId,
              variantName: draft.variantName?.trim() || undefined,
            }
          : {}),
      },
      {
        onError: (e: any) =>
          toast({
            title: "Failed to save product",
            description: String(e?.response?.data?.message ?? "Check the fields and try again."),
            variant: "error",
          }),
      },
    );
    setIsEditing(false);
  };

  const cancelEdit = () => {
    setEditDraft({});
    setIsEditing(false);
  };

  // ── Delete (mirrors the mobile app's confirm → toast → navigate-back flow) ─
  const handleDeleteProduct = async () => {
    try {
      await deleteProduct.mutateAsync(params.id);
      toast({ title: "Product deleted", variant: "success" });
      router.push("/products");
    } catch (err: any) {
      toast({
        title: "Failed to delete product",
        description: err?.response?.data?.message,
        variant: "error",
      });
    } finally {
      setShowDeleteConfirm(false);
    }
  };

  // ── Crop helpers ──────────────────────────────────────────────────────────

  /** Called by the drop zone / file input — opens the crop modal queue. */
  const queueForCrop = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // FileList is a live reference to the input's files; copy it BEFORE
    // clearing the input value, otherwise the array becomes empty.
    const queue = Array.from(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setCropState({ queue, accumulated: [] });
  };

  /** Called by CropModal each time the user confirms one crop + focal. */
  const handleCropConfirm = async (blob: Blob, focal: FocalPoint) => {
    if (!cropState) return;
    const accumulated = [...cropState.accumulated, { blob, focal }];
    const queue = cropState.queue.slice(1);

    if (queue.length === 0) {
      setCropState(null);
      try {
        if (cropExistingKey) {
          // Replacing an existing image: upload cropped version first, then remove original.
          const { blob: b, focal: f } = accumulated[0];
          const file = new File([b], `product-image-${Date.now()}.jpg`, { type: "image/jpeg" });
          await uploadImages.mutateAsync({ files: [file], focals: [f] });
          await deleteImage.mutateAsync(cropExistingKey);
          setCropExistingKey(null);
          toast({ title: "Image cropped and replaced", variant: "success" });
        } else {
          // Normal upload flow — upload all cropped blobs with their focals.
          const files = accumulated.map(
            ({ blob: b }, i) =>
              new File([b], `product-image-${Date.now()}-${i}.jpg`, { type: "image/jpeg" }),
          );
          const focals = accumulated.map(({ focal: f }) => f);
          await uploadImages.mutateAsync({ files, focals });
          toast({
            title: `${files.length} image${files.length !== 1 ? "s" : ""} uploaded`,
            variant: "success",
          });
        }
      } catch {
        toast({ title: "Upload failed", variant: "error" });
      }
    } else {
      setCropState({ queue, accumulated });
    }
  };

  /** Called if the user cancels the entire crop session. */
  const handleCropCancel = () => {
    setCropExistingKey(null);
    setCropState(null);
  };

  // ── Operator-only image management ────────────────────────────────────────

  /** Move image at fromIdx to toIdx, updating imageKeys order via PATCH. */
  const handleMoveImage = async (fromIdx: number, toIdx: number) => {
    const keys: string[] = [...((product as any).imageKeys ?? [])];
    if (toIdx < 0 || toIdx >= keys.length) return;
    const [moved] = keys.splice(fromIdx, 1);
    keys.splice(toIdx, 0, moved);
    try {
      await updateProduct.mutateAsync({ id: params.id, imageKeys: keys });
      setActiveImageIdx(toIdx);
    } catch {
      toast({ title: "Reorder failed", variant: "error" });
    }
  };

  /** Move the image at index i to position 0 (making it the default/first). */
  const handleSetDefault = (i: number) => handleMoveImage(i, 0);

  /** Fetch an existing image by URL, open it in the crop modal, and replace the original on confirm. */
  const handleCropExisting = async (imageUrl: string, key: string | undefined) => {
    if (!imageUrl || !key) return;
    try {
      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      const file = new File([blob], "existing-image.jpg", { type: blob.type || "image/jpeg" });
      setCropExistingKey(key);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setCropState({ queue: [file], accumulated: [] });
    } catch {
      toast({ title: "Failed to load image for cropping", variant: "error" });
    }
  };

  // ── Variant helpers ─────────────────────────────────────────────────────

  const openVariantModal = (variant?: ApiProduct) => {
    if (variant) {
      const vp = parseFloat(String(variant.pricePerUnit));
      setEditingVariant(variant);
      setVariantForm({
        variantName: variant.variantName ?? "",
        sku: variant.sku ?? "",
        unitSku: variant.unitSku ?? "",
        price: String(vp),
        unit: variant.unit ?? product.unit,
        priceTier2: String(parseFloat(String((variant as any).priceTier2 ?? vp))),
        priceTier3: String(parseFloat(String((variant as any).priceTier3 ?? vp))),
        priceTier4: String(parseFloat(String((variant as any).priceTier4 ?? vp))),
        priceTier5: String(parseFloat(String((variant as any).priceTier5 ?? vp))),
      });
    } else {
      setEditingVariant(null);
      setVariantForm({
        variantName: "",
        sku: "",
        unitSku: "",
        price: String(priceNumber),
        unit: product.unit,
        priceTier2: String(parseFloat(String((product as any).priceTier2 ?? priceNumber))),
        priceTier3: String(parseFloat(String((product as any).priceTier3 ?? priceNumber))),
        priceTier4: String(parseFloat(String((product as any).priceTier4 ?? priceNumber))),
        priceTier5: String(parseFloat(String((product as any).priceTier5 ?? priceNumber))),
      });
    }
    setVariantModalOpen(true);
  };

  const closeVariantModal = () => {
    setVariantModalOpen(false);
    setEditingVariant(null);
  };

  const handleVariantSubmit = () => {
    if (!variantForm.variantName.trim()) {
      toast({ title: "Variant name is required", variant: "error" });
      return;
    }
    if (editingVariant) {
      updateProduct.mutate(
        {
          id: editingVariant.id,
          variantName: variantForm.variantName,
          sku: variantForm.sku || undefined,
          unitSku: variantForm.unitSku || undefined,
          // Cleared fields fall back like the create branch — never send ""
          // (rejected by @IsDecimal).
          pricePerUnit: variantForm.price || String(product.pricePerUnit),
          priceTier2: variantForm.priceTier2 || variantForm.price || undefined,
          priceTier3: variantForm.priceTier3 || variantForm.price || undefined,
          priceTier4: variantForm.priceTier4 || variantForm.price || undefined,
          priceTier5: variantForm.priceTier5 || variantForm.price || undefined,
        },
        {
          onSuccess: () => {
            toast({ title: "Variant updated", variant: "success" });
            closeVariantModal();
          },
          onError: () => toast({ title: "Failed to update variant", variant: "error" }),
        },
      );
    } else {
      createProduct.mutate(
        {
          // `name` stores only the variant name; parent context comes from
          // `parentProductId`. UI composes the display name when needed.
          name: variantForm.variantName,
          parentProductId: product.id,
          variantName: variantForm.variantName,
          sku: variantForm.sku || undefined,
          unitSku: variantForm.unitSku || undefined,
          unit: variantForm.unit || product.unit,
          pricePerUnit: variantForm.price || String(product.pricePerUnit),
          priceTier2: variantForm.priceTier2 || variantForm.price || String(product.pricePerUnit),
          priceTier3: variantForm.priceTier3 || variantForm.price || String(product.pricePerUnit),
          priceTier4: variantForm.priceTier4 || variantForm.price || String(product.pricePerUnit),
          priceTier5: variantForm.priceTier5 || variantForm.price || String(product.pricePerUnit),
          category: product.category || undefined,
        },
        {
          onSuccess: () => {
            toast({ title: "Variant created", variant: "success" });
            closeVariantModal();
          },
          onError: () => toast({ title: "Failed to create variant", variant: "error" }),
        },
      );
    }
  };

  const handleToggleVariantActive = (variant: ApiProduct) => {
    if (variant.isActive) {
      if (!window.confirm("Deactivate this variant?")) return;
      updateProduct.mutate(
        { id: variant.id, isActive: false },
        { onSuccess: () => toast({ title: "Variant deactivated", variant: "success" }) },
      );
    } else {
      updateProduct.mutate(
        { id: variant.id, isActive: true },
        { onSuccess: () => toast({ title: "Variant reactivated", variant: "success" }) },
      );
    }
  };

  // ── "Make variant of" helpers ─────────────────────────────────────────────

  const openMakeVariantModal = () => {
    setMakeVariantParentId("");
    setMakeVariantName(product.variantName ?? "");
    setMakeVariantParentOwnName("");
    setMakeVariantOpen(true);
  };

  const handleMakeVariantScan = async (code: string) => {
    setMakeVariantScanLoading(true);
    try {
      const found = await apiClient
        .get(`/products/barcode/${encodeURIComponent(code)}`)
        .then((r) => r.data);
      // If the scanned product is itself a variant, resolve to its parent
      const parentId: string = found.parentProductId || found.id;
      // Don't allow linking to self
      if (parentId === params.id) {
        toast({ title: "Cannot link a product to itself", variant: "error" });
        return;
      }
      setMakeVariantParentId(parentId);
    } catch {
      toast({ title: "Product not found for that barcode", variant: "error" });
    } finally {
      setMakeVariantScanLoading(false);
    }
  };

  const handleMakeVariantSubmit = () => {
    if (!makeVariantParentId) {
      toast({ title: "Please select a parent product", variant: "error" });
      return;
    }
    if (!makeVariantName.trim()) {
      toast({ title: "Flavor / variety name is required", variant: "error" });
      return;
    }
    const parentProduct = allProducts.find((p: any) => p.id === makeVariantParentId) as any;
    const baseName = parentProduct?.name ?? product.name;
    const newName = `${baseName} - ${makeVariantName.trim()}`;

    // If the parent has no variantName yet, assign it one first
    const parentNeedsName =
      parentProduct && !parentProduct.variantName && makeVariantParentOwnName.trim();
    const doLink = () =>
      updateProduct.mutate(
        {
          id: params.id,
          parentProductId: makeVariantParentId,
          variantName: makeVariantName.trim(),
          name: newName,
        },
        {
          onSuccess: () => {
            toast({ title: "Product linked as variant", variant: "success" });
            setMakeVariantOpen(false);
          },
          onError: () => toast({ title: "Failed to link as variant", variant: "error" }),
        },
      );

    if (parentNeedsName) {
      const parentNewName = `${baseName} - ${makeVariantParentOwnName.trim()}`;
      updateProduct.mutate(
        {
          id: makeVariantParentId,
          variantName: makeVariantParentOwnName.trim(),
          name: parentNewName,
        },
        {
          onSuccess: doLink,
          onError: () => toast({ title: "Failed to update parent variant name", variant: "error" }),
        },
      );
    } else {
      doLink();
    }
  };

  // ── "Link existing product as variant" helpers ────────────────────────────

  const openLinkExistingModal = () => {
    setLinkExistingProductId("");
    setLinkExistingVariantName("");
    setLinkExistingParentVariantName(product.variantName ?? "");
    setLinkExistingSearch("");
    setLinkExistingOpen(true);
  };

  // Derive filterable candidates: standalone products that aren't already variants of this product
  const existingVariantIds = new Set((product?.variants ?? []).map((v: any) => v.id));
  const linkCandidates = allProducts.filter(
    (p: any) =>
      !p.parentProductId && // standalone only
      p.id !== params.id && // not self
      !existingVariantIds.has(p.id), // not already a variant of this product
  );
  const filteredLinkCandidates = linkExistingSearch
    ? linkCandidates.filter(
        (p: any) =>
          p.name.toLowerCase().includes(linkExistingSearch.toLowerCase()) ||
          (p.sku && p.sku.toLowerCase().includes(linkExistingSearch.toLowerCase())),
      )
    : linkCandidates;

  const handleLinkExistingSubmit = () => {
    if (!linkExistingProductId) {
      toast({ title: "Please select a product", variant: "error" });
      return;
    }
    if (!linkExistingVariantName.trim()) {
      toast({ title: "Flavor / variety name is required", variant: "error" });
      return;
    }
    const baseName = product.name;
    const composedName = `${baseName} - ${linkExistingVariantName.trim()}`;

    // Link the selected product as a child variant
    const doLinkChild = () =>
      updateProduct.mutate(
        {
          id: linkExistingProductId,
          parentProductId: product.id,
          variantName: linkExistingVariantName.trim(),
          name: composedName,
        },
        {
          onSuccess: () => {
            toast({ title: "Product linked as variant", variant: "success" });
            setLinkExistingOpen(false);
          },
          onError: () => toast({ title: "Failed to link product", variant: "error" }),
        },
      );

    // If the current (parent) product has no variantName yet, assign it one first
    const parentNeedsName = !product.variantName && linkExistingParentVariantName.trim();
    if (parentNeedsName) {
      const parentNewName = `${baseName} - ${linkExistingParentVariantName.trim()}`;
      updateProduct.mutate(
        { id: product.id, variantName: linkExistingParentVariantName.trim(), name: parentNewName },
        {
          onSuccess: doLinkChild,
          onError: () => toast({ title: "Failed to update parent variant name", variant: "error" }),
        },
      );
    } else {
      doLinkChild();
    }
  };

  // ── Unlink from parent ────────────────────────────────────────────────────

  const handleUnlinkFromParent = () => {
    if (
      !window.confirm(
        "Unlink this product from its parent? It will become a standalone product again.",
      )
    )
      return;
    updateProduct.mutate(
      { id: params.id, parentProductId: null, variantName: null },
      {
        onSuccess: () => toast({ title: "Product unlinked — now standalone", variant: "success" }),
        onError: () => toast({ title: "Failed to unlink", variant: "error" }),
      },
    );
  };

  // Display-only per-unit hint for a case-packed product's price fields (Tier 1 row + tier
  // grid). NEVER enters a payload — perUnitPrice is a display derivation, not line math.
  // Reads `activeUnitsPerBox` (the in-progress edit draft while editing, the saved value
  // otherwise) — NOT `product.unitsPerBox` directly — so accepting a pack-size suggestion
  // shows the resulting per-piece price immediately, live, before the operator ever saves.
  const perUnitHint = (v: number) => {
    if (!(activeUnitsPerBox > 1)) return null;
    const pu = perUnitPrice(v, activeUnitsPerBox);
    return pu != null ? (
      <p className="mt-0.5 text-[11px] text-navy/50">≈ ${pu.toFixed(2)} / unit</p>
    ) : null;
  };

  return (
    <>
      {/* Crop-before-upload modal — intercepts every file selection */}
      {cropState && (
        <CropModal
          file={cropState.queue[0]}
          fileIndex={cropState.accumulated.length}
          fileTotal={cropState.accumulated.length + cropState.queue.length}
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}
      {/* Full-screen image lightbox — any user can open this */}
      {lightboxOpen && ((product as any).imageUrls?.length ?? 0) > 0 && (
        <ImageLightbox
          images={(product as any).imageUrls}
          startIndex={lightboxIdx}
          onClose={() => setLightboxOpen(false)}
        />
      )}
      {/* Set-cost modal — writes an audited COST_BASIS movement, same component
          as the Inventory Stock tab (table row + search suggestions). */}
      {showCostModal && (
        <SetCostModal
          item={{
            id: product.id,
            name: product.name,
            unit: product.unit,
            currentStock,
            unitsPerBox: product.unitsPerBox,
            averageCost: product.averageCost != null ? Number(product.averageCost) : null,
          }}
          onClose={() => setShowCostModal(false)}
        />
      )}
      {/* Variant-split modal (PR-D) — moves this product's unassigned stock
          onto its variants. Same component as the Inventory Stock tab row
          action and the vendor-bill line badge. */}
      {showVariantSplit && (
        <VariantSplitModal
          parent={{
            id: product.id,
            name: product.name,
            currentStock,
            averageCost: product.averageCost != null ? Number(product.averageCost) : null,
            unitsPerBox: product.unitsPerBox ?? null,
            costingMethod: product.costingMethod,
          }}
          pool={currentStock}
          onClose={() => setShowVariantSplit(false)}
          onSuccess={() => setShowVariantSplit(false)}
        />
      )}
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteProduct}
        title="Delete product?"
        description={`${product.name} will be deactivated and hidden from the catalog. Existing order and invoice history is preserved. Products with an in-flight (undelivered) order cannot be deleted.`}
        confirmLabel="Yes, delete"
        variant="danger"
        loading={deleteProduct.isPending}
      />
      <div className="space-y-5 p-6">
        {/* Back */}
        <Link
          href="/products"
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-navy/70 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Products
        </Link>

        {/* Page header — name, status badges, provenance line */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-[-0.01em] text-navy">{product.name}</h1>
              <Badge
                variant={product.isActive ? "success" : "neutral"}
                label={product.isActive ? "Active" : "Inactive"}
              />
              {stockStatus === "OUT_OF_STOCK" ? (
                <Badge variant="danger" label="Out of Stock" />
              ) : stockStatus === "LOW" ? (
                <Badge variant="warning" label="Low Stock" />
              ) : null}
              {(product as any).isTobacco && <Badge variant="warning" label="Tobacco" />}
              {(product as any).isFeatured && <Badge variant="info" label="Featured" />}
              {(product as any).isNew && <Badge variant="info" label="New" />}
              {(product as any).isDeal && <Badge variant="success" label="Deal" />}
            </div>
            <p className="mt-1.5 text-sm text-navy/70">
              {product.sku && <span className="font-mono">{product.sku}</span>}
              {product.sku && (product.category || product.parent) ? " · " : ""}
              {product.parent ? `Variant of ${product.parent.name}` : product.category}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* ── Left: image gallery + stock card ── */}
          <div className="space-y-4">
            {/* ── Image gallery ── */}
            <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
              <div className="border-b border-surface-border px-4 py-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                  Image
                </h3>
              </div>
              <div className="p-4">
                {(() => {
                  const images: string[] = (product as any).imageUrls ?? [];
                  const hasImages = images.length > 0;
                  const safeIdx = Math.min(activeImageIdx, images.length - 1);

                  const handleUpload = (files: FileList | null) => queueForCrop(files);

                  const toggleSelectImage = (i: number) => {
                    setSelectedImages((prev) => {
                      const next = new Set(prev);
                      next.has(i) ? next.delete(i) : next.add(i);
                      return next;
                    });
                  };

                  const deleteSelected = async () => {
                    const keys = (product as any).imageKeys ?? [];
                    const toDelete = Array.from(selectedImages)
                      .map((i) => keys[i])
                      .filter(Boolean);
                    try {
                      // Delete sequentially — concurrent Prisma array-pull calls race
                      // against each other and only some keys end up removed.
                      for (const k of toDelete) {
                        await deleteImage.mutateAsync(k);
                      }
                      setSelectedImages(new Set());
                      setSelectMode(false);
                      setActiveImageIdx(0);
                      toast({
                        title: `${toDelete.length} image${toDelete.length !== 1 ? "s" : ""} deleted`,
                        variant: "success",
                      });
                    } catch {
                      toast({ title: "Delete failed", variant: "error" });
                    }
                  };

                  return (
                    <div className="space-y-2">
                      {/* Main image / drop zone — 4:5 portrait viewport matching the
                    upload ratio. object-cover + object-position uses each
                    image's stored focal point to keep the right area visible
                    even when the image is from before the focal-point
                    feature (those default to centre). */}
                      <div
                        onDragOver={(e) => {
                          e.preventDefault();
                          setIsDragging(true);
                        }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setIsDragging(false);
                          handleUpload(e.dataTransfer.files);
                        }}
                        className={cn(
                          "relative aspect-[4/5] w-full overflow-hidden rounded-xl border",
                          isDragging && "ring-2 ring-brand-500",
                          !hasImages && "cursor-pointer",
                          stockStatus === "LOW" && "border-warning/30 bg-warning-bg",
                          stockStatus === "OUT_OF_STOCK" && "border-danger/30 bg-danger-bg",
                          stockStatus === "IN_STOCK" && "border-surface-border bg-surface-raised",
                        )}
                        onClick={!hasImages ? () => fileInputRef.current?.click() : undefined}
                      >
                        {hasImages ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={images[safeIdx]}
                              alt={`${product.name} — image ${safeIdx + 1}`}
                              className="absolute inset-0 h-full w-full object-cover cursor-zoom-in"
                              style={{ objectPosition: objectPositionForUrl(images[safeIdx]) }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setLightboxIdx(safeIdx);
                                setLightboxOpen(true);
                              }}
                            />
                            {/* Delete current image (single) */}
                            {!selectMode && (
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const key = (product as any).imageKeys?.[safeIdx];
                                  if (!key) return;
                                  try {
                                    await deleteImage.mutateAsync(key);
                                    setActiveImageIdx(0);
                                    toast({ title: "Image deleted", variant: "success" });
                                  } catch {
                                    toast({ title: "Delete failed", variant: "error" });
                                  }
                                }}
                                className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white hover:bg-danger transition-colors"
                                title="Delete this image"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {/* Prev / next arrows */}
                            {images.length > 1 && !selectMode && (
                              <>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveImageIdx(
                                      (i) => (i - 1 + images.length) % images.length,
                                    );
                                  }}
                                  className="absolute left-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
                                >
                                  <ChevronLeft className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveImageIdx((i) => (i + 1) % images.length);
                                  }}
                                  className="absolute right-8 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
                                >
                                  <ChevronRight className="h-4 w-4" />
                                </button>
                              </>
                            )}
                            {/* Page indicator */}
                            {images.length > 1 && !selectMode && (
                              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-2 py-0.5 text-xs text-white">
                                {safeIdx + 1} / {images.length}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="flex h-full flex-col items-center justify-center gap-2">
                            <Package
                              className={cn(
                                "h-14 w-14",
                                stockStatus === "LOW" && "text-warning/30",
                                stockStatus === "OUT_OF_STOCK" && "text-danger/30",
                                stockStatus === "IN_STOCK" && "text-navy/15",
                              )}
                            />
                            <p className="text-xs text-navy/70">
                              Drop images here or click to upload
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Thumbnail strip with checkboxes in select mode */}
                      {images.length > 0 && (
                        <div className="flex gap-1.5 overflow-x-auto pb-1">
                          {images.map((url, i) => (
                            <div key={i} className="relative shrink-0">
                              <button
                                onClick={() =>
                                  selectMode ? toggleSelectImage(i) : setActiveImageIdx(i)
                                }
                                className={cn(
                                  "h-14 w-14 overflow-hidden rounded-lg border-2 transition-all",
                                  selectMode && selectedImages.has(i) && "border-danger",
                                  !selectMode && i === safeIdx
                                    ? "border-brand-500"
                                    : !selectMode
                                      ? "border-transparent opacity-60 hover:opacity-100"
                                      : "border-surface-border",
                                )}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={url}
                                  alt={`thumb ${i + 1}`}
                                  className="h-full w-full object-cover"
                                  style={{ objectPosition: objectPositionForUrl(url) }}
                                />
                              </button>
                              {selectMode && (
                                <input
                                  type="checkbox"
                                  checked={selectedImages.has(i)}
                                  onChange={() => toggleSelectImage(i)}
                                  className="absolute left-0.5 top-0.5 h-3.5 w-3.5 cursor-pointer accent-danger"
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Operator-only controls for the active image */}
                      {isOperator && !selectMode && hasImages && (
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-border pt-2">
                          {/* Move left / right */}
                          <button
                            onClick={() => handleMoveImage(safeIdx, safeIdx - 1)}
                            disabled={safeIdx === 0 || updateProduct.isPending}
                            title="Move left"
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-surface-border text-navy/70 hover:text-navy disabled:opacity-30 transition-colors"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleMoveImage(safeIdx, safeIdx + 1)}
                            disabled={safeIdx === images.length - 1 || updateProduct.isPending}
                            title="Move right"
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-surface-border text-navy/70 hover:text-navy disabled:opacity-30 transition-colors"
                          >
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>

                          {/* Default / Set default */}
                          {safeIdx === 0 ? (
                            <span className="flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-600 select-none">
                              <Star className="h-3 w-3 fill-brand-500 text-brand-500" />
                              Default
                            </span>
                          ) : (
                            <button
                              onClick={() => handleSetDefault(safeIdx)}
                              disabled={updateProduct.isPending}
                              title="Set as default image (move to first position)"
                              className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1 text-xs text-navy/70 hover:border-brand-200 hover:text-brand-500 disabled:opacity-30 transition-colors"
                            >
                              <Star className="h-3 w-3" />
                              Set default
                            </button>
                          )}

                          {/* Crop / re-set focal — re-runs the crop + focal-point
                        flow on the existing image and replaces the original. */}
                          <button
                            onClick={() =>
                              handleCropExisting(
                                images[safeIdx],
                                (product as any).imageKeys?.[safeIdx],
                              )
                            }
                            disabled={!!cropState || uploadImages.isPending}
                            title="Re-crop and/or move the focal point (replaces the original image)"
                            className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1 text-xs text-navy/70 hover:text-navy disabled:opacity-30 transition-colors"
                          >
                            <Scissors className="h-3 w-3" />
                            Crop / focal
                          </button>
                        </div>
                      )}

                      {/* Action row: select-mode toggle + bulk delete + upload */}
                      <div className="flex items-center gap-2">
                        {hasImages &&
                          (selectMode ? (
                            <>
                              <button
                                onClick={deleteSelected}
                                disabled={selectedImages.size === 0 || deleteImage.isPending}
                                className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white hover:bg-danger/90 disabled:opacity-40 transition-colors"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Delete {selectedImages.size > 0 ? `${selectedImages.size} ` : ""}
                                selected
                              </button>
                              <button
                                onClick={() => {
                                  setSelectMode(false);
                                  setSelectedImages(new Set());
                                }}
                                className="rounded-lg border border-surface-border px-3 py-1.5 text-xs text-navy/70 hover:text-navy transition-colors"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setSelectMode(true)}
                              className="flex items-center gap-1.5 rounded-lg border border-surface-border px-3 py-1.5 text-xs text-navy/70 hover:text-navy transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Select to delete
                            </button>
                          ))}
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploadImages.isPending || !!cropState}
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-white py-1.5 text-xs text-navy/70 hover:border-brand-500/50 hover:text-brand-500 transition-colors disabled:opacity-50"
                        >
                          <Upload className="h-3.5 w-3.5" />
                          {uploadImages.isPending ? "Uploading…" : "Upload images"}
                        </button>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => handleUpload(e.target.files)}
                      />
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
              <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                  Stock &amp; Cost
                </h3>
                <button
                  type="button"
                  onClick={() => setShowCostModal(true)}
                  className="text-xs font-medium text-brand-600 transition-colors hover:underline"
                >
                  Set cost
                </button>
              </div>
              <div className="px-4">
                <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
                  <span className="text-navy/70">Stock status</span>
                  {stockStatus === "OUT_OF_STOCK" ? (
                    <Badge variant="danger" label="Out of Stock" />
                  ) : stockStatus === "LOW" ? (
                    <Badge variant="warning" label="Low Stock" />
                  ) : (
                    <Badge variant="success" label="In Stock" />
                  )}
                </div>
                <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
                  <span className="text-navy/70">On hand</span>
                  <span className="font-mono font-medium tabular-nums text-navy">
                    {unitsLabel(currentStock, product.unitsPerBox, product.unit)}
                  </span>
                </div>
                {!product.parentProductId && (product.variants?.length ?? 0) > 0 && (
                  <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
                    <span
                      className="text-navy/70"
                      title="Stock on this generic not yet attributed to a variant"
                    >
                      Unassigned stock
                    </span>
                    <span className="font-mono font-medium tabular-nums text-navy">
                      {unitsLabel(currentStock, product.unitsPerBox, product.unit)}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
                  <span className="text-navy/70">Waitlist</span>
                  <span
                    className={
                      (product.stockAlertCount ?? 0) > 0
                        ? "font-mono font-medium tabular-nums text-amber-700"
                        : "font-mono font-medium tabular-nums text-navy/50"
                    }
                  >
                    {product.stockAlertCount ?? 0} waiting for restock
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-surface-border py-3 text-sm">
                  <span className="text-navy/70">Avg cost</span>
                  {product.averageCost != null ? (
                    <span className="font-mono font-medium tabular-nums text-navy">
                      ${parseFloat(String(product.averageCost)).toFixed(2)}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowCostModal(true)}
                      title="No cost basis recorded — click to set one"
                      className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 transition-colors hover:bg-amber-200"
                    >
                      No cost set
                    </button>
                  )}
                </div>
                <Link
                  href={`/inventory/movements?product=${product.id}`}
                  className="block py-3 text-xs font-semibold text-brand-600 hover:underline"
                >
                  View stock movements →
                </Link>
              </div>
            </div>
          </div>

          {/* ── Right: details + chart ── */}
          <div className="space-y-5 lg:col-span-2">
            {/* Product details */}
            <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-5 py-3.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                  Details
                </h3>
                <div className="flex shrink-0 items-center gap-2">
                  {isEditing ? (
                    <>
                      <button
                        onClick={cancelEdit}
                        title="Cancel"
                        className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                      <Button
                        size="sm"
                        onClick={saveEdit}
                        loading={updateProduct.isPending}
                        leftIcon={<Check className="h-4 w-4" />}
                      >
                        Save
                      </Button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={startEdit}
                        title="Edit product"
                        className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {isOperator && !product.parentProductId && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={openMakeVariantModal}
                          title="Link this product as a variant of another product"
                        >
                          Make variant of…
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateProduct.mutate({ id: params.id, isActive: !product.isActive })
                        }
                        loading={updateProduct.isPending}
                      >
                        {product.isActive ? "Deactivate" : "Activate"}
                      </Button>
                      {hasTobaccoAddon && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            updateProduct.mutate({
                              id: params.id,
                              isTobacco: !(product as any).isTobacco,
                            } as any)
                          }
                          loading={updateProduct.isPending}
                          title="Tobacco products are tracked separately for monthly tax reports"
                        >
                          {(product as any).isTobacco ? "Unmark tobacco" : "Mark as tobacco"}
                        </Button>
                      )}
                      {isOperator && (
                        <Button
                          size="sm"
                          variant="danger"
                          leftIcon={<Trash2 className="h-4 w-4" />}
                          onClick={() => setShowDeleteConfirm(true)}
                        >
                          Delete
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="p-5">
                {/* Edit-mode name field — view mode shows the name in the page header */}
                {isEditing && (
                  <div className="mb-4">
                    {(() => {
                      const editParent = (editDraft.parentProductId as string)
                        ? allProducts.find((p: any) => p.id === editDraft.parentProductId)
                        : null;
                      const previewName =
                        editParent && (editDraft.variantName as string)?.trim()
                          ? `${(editParent as any).name} - ${(editDraft.variantName as string).trim()}`
                          : null;
                      return editParent ? (
                        <div>
                          <p className="w-full rounded border border-surface-border bg-surface-raised px-2 py-1 text-lg font-bold text-navy/70 select-none">
                            {previewName ?? (
                              <span className="text-navy/30 italic text-sm font-normal">
                                auto-composed from parent + flavor
                              </span>
                            )}
                          </p>
                          <p className="mt-0.5 text-xs text-navy/70 italic">
                            Name auto-composed from parent + flavor
                          </p>
                        </div>
                      ) : (
                        <input
                          value={(editDraft.name as string) ?? ""}
                          onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                          className="w-full rounded border border-surface-border px-2 py-1 text-lg font-bold text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      );
                    })()}
                  </div>
                )}

                {/* The regulated type/category banner that used to sit here moved into
                    the Regulatory reporting card below, so regulated info lives in
                    exactly one place instead of straddling two. */}

                {/* Tobacco compliance banner */}
                {(product as any).isTobacco && (
                  <div className="mb-4 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-4 py-2">
                    <p className="text-sm text-amber-900">
                      <span className="font-semibold">Tobacco product</span> — purchases and sales
                      are tracked separately for monthly tax reports.
                    </p>
                    {/* The standalone /tobacco surface retired into the Regulated Items hub
                        (2026-08-24 consolidation) — link straight at this product's own
                        regulated section, falling back to the hub when it has none. */}
                    <Link
                      href={
                        product.trackedCategory
                          ? `/compliance/${product.trackedCategory.id}`
                          : "/compliance"
                      }
                      className="text-xs font-medium text-amber-800 underline"
                    >
                      Regulated Items →
                    </Link>
                  </div>
                )}

                {/* Buyer merchandising flags (P5-01) */}
                {isOperator && (
                  <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
                    <div className="mb-2.5 flex items-center gap-2">
                      <Star className="h-4 w-4 text-brand-500" />
                      <h3 className="text-sm font-semibold text-navy">Buyer merchandising</h3>
                    </div>
                    <p className="mb-3 text-xs text-navy/60">
                      Highlight this product on the buyer catalogue with badges and smart
                      collections. These are display flags only — they don&apos;t change price.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <MerchFlagToggle
                        label="Featured"
                        description="Pin to the featured shelf"
                        active={!!(product as any).isFeatured}
                        disabled={updateProduct.isPending}
                        onToggle={() =>
                          updateProduct.mutate(
                            { id: params.id, isFeatured: !(product as any).isFeatured } as any,
                            {
                              onSuccess: () =>
                                toast({ title: "Merchandising updated", variant: "success" }),
                              onError: () => toast({ title: "Failed to update", variant: "error" }),
                            },
                          )
                        }
                      />
                      <MerchFlagToggle
                        label="New"
                        description={'Show a "New" badge'}
                        active={!!(product as any).isNew}
                        disabled={updateProduct.isPending}
                        onToggle={() =>
                          updateProduct.mutate(
                            { id: params.id, isNew: !(product as any).isNew } as any,
                            {
                              onSuccess: () =>
                                toast({ title: "Merchandising updated", variant: "success" }),
                              onError: () => toast({ title: "Failed to update", variant: "error" }),
                            },
                          )
                        }
                      />
                      <MerchFlagToggle
                        label="Deal"
                        description={'Show a "Deal" badge'}
                        active={!!(product as any).isDeal}
                        disabled={updateProduct.isPending}
                        onToggle={() =>
                          updateProduct.mutate(
                            { id: params.id, isDeal: !(product as any).isDeal } as any,
                            {
                              onSuccess: () =>
                                toast({ title: "Merchandising updated", variant: "success" }),
                              onError: () => toast({ title: "Failed to update", variant: "error" }),
                            },
                          )
                        }
                      />
                    </div>
                  </div>
                )}

                {/* Parent link banner for variants */}
                {product.parentProductId && product.parent && (
                  <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 mb-4">
                    <p className="text-sm text-blue-700">
                      This is a variant of{" "}
                      <Link
                        href={`/products/${product.parentProductId}`}
                        className="font-medium underline"
                      >
                        {product.parent.name}
                      </Link>
                    </p>
                    {isOperator && (
                      <button
                        onClick={handleUnlinkFromParent}
                        className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        Unlink
                      </button>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                  <InfoRow
                    label="SKU / Barcode"
                    value={
                      isEditing ? (
                        <input
                          value={(editDraft.sku as string) ?? ""}
                          onChange={(e) => setEditDraft((d) => ({ ...d, sku: e.target.value }))}
                          className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      ) : (
                        (product.sku ?? <span className="text-navy/30">—</span>)
                      )
                    }
                  />
                  <InfoRow
                    label="Unit code"
                    value={
                      isEditing ? (
                        <input
                          value={(editDraft.unitSku as string) ?? ""}
                          onChange={(e) => setEditDraft((d) => ({ ...d, unitSku: e.target.value }))}
                          placeholder="Same as case code"
                          className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      ) : (
                        (product.unitSku ?? (
                          <span className="text-navy/30">— (same as case code)</span>
                        ))
                      )
                    }
                  />
                  <InfoRow
                    label="Category"
                    value={
                      isEditing ? (
                        (editDraft.trackedCategoryId as string) ? (
                          <SubcategoryCombobox
                            sectionId={(editDraft.trackedCategoryId as string) || null}
                            value={(editDraft.trackedSubcategoryId as string) ?? ""}
                            onChange={(id) =>
                              setEditDraft((d) => ({ ...d, trackedSubcategoryId: id }))
                            }
                            className="px-2 py-1"
                          />
                        ) : (
                          <CategoryCombobox
                            value={(editDraft.category as string) ?? ""}
                            onChange={(v) => setEditDraft((d) => ({ ...d, category: v }))}
                            placeholder="Select or type a category"
                            className="px-2 py-1"
                          />
                        )
                      ) : (
                        product.category
                      )
                    }
                  />
                  {/* Regulated type, item type and the regulatory units of measure
                      deliberately do NOT live in this grid — they are filing
                      vocabulary, not catalog fields, and sitting next to the plain
                      "Unit of Measure"/"Units per case" inputs made the two easy to
                      confuse. They render in the Regulatory reporting card below. */}
                  <InfoRow
                    label="Unit of Measure"
                    value={
                      isEditing ? (
                        <>
                          <input
                            list="edit-unit-options"
                            value={(editDraft.unit as string) ?? ""}
                            onChange={(e) => setEditDraft((d) => ({ ...d, unit: e.target.value }))}
                            placeholder="Select or type a unit"
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <datalist id="edit-unit-options">
                            {catalogUnits.map((u) => (
                              <option key={u} value={u} />
                            ))}
                          </datalist>
                        </>
                      ) : (
                        product.unit
                      )
                    }
                  />
                  <InfoRow
                    label="Units per case"
                    value={
                      isEditing ? (
                        <DecimalInput
                          decimals={0}
                          min={0}
                          value={
                            (editDraft.unitsPerBox as string)?.trim()
                              ? parseFloat(editDraft.unitsPerBox as string)
                              : null
                          }
                          onChange={(v) =>
                            setEditDraft((d) => ({ ...d, unitsPerBox: v == null ? "" : String(v) }))
                          }
                          className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      ) : Number(product.unitsPerBox) > 1 ? (
                        `${product.unitsPerBox} units`
                      ) : (
                        "Sold individually"
                      )
                    }
                  />
                  <InfoRow
                    label={`${tierLabel(tierLabels, 1)} Price (List)`}
                    value={
                      isEditing ? (
                        <>
                          <EditableNumber
                            value={parseFloat(String(editDraft.pricePerUnit ?? priceNumber))}
                            onChange={(v) =>
                              setEditDraft((d) => ({ ...d, pricePerUnit: String(v) }))
                            }
                          />
                          {perUnitHint(parseFloat(String(editDraft.pricePerUnit ?? priceNumber)))}
                        </>
                      ) : (
                        <>
                          <span className="font-mono tabular-nums">${priceNumber.toFixed(2)}</span>
                          {perUnitHint(priceNumber)}
                        </>
                      )
                    }
                  />
                  {/* Variant of — always show when editing; in view mode show only if product has a parent */}
                  {(isEditing || product.parentProductId) && (
                    <InfoRow
                      label="Variant of"
                      value={
                        isEditing ? (
                          <select
                            value={(editDraft.parentProductId as string) ?? ""}
                            onChange={(e) =>
                              setEditDraft((d) => ({
                                ...d,
                                parentProductId: e.target.value,
                                variantName: e.target.value ? (d.variantName as string) : "",
                              }))
                            }
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value="">None (standalone product)</option>
                            {variantOfCandidates.map((p: any) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                                {p.sku ? ` — ${p.sku}` : ""}
                              </option>
                            ))}
                          </select>
                        ) : product.parent ? (
                          <Link
                            href={`/products/${product.parentProductId}`}
                            className="text-brand-600 underline text-sm"
                          >
                            {product.parent.name}
                          </Link>
                        ) : (
                          "—"
                        )
                      }
                    />
                  )}
                  {/* Flavor / variety — only when a parent is selected */}
                  {isEditing && (editDraft.parentProductId as string) && (
                    <InfoRow
                      label="Flavor / variety"
                      value={
                        <div>
                          <input
                            value={(editDraft.variantName as string) ?? ""}
                            onChange={(e) =>
                              setEditDraft((d) => ({ ...d, variantName: e.target.value }))
                            }
                            placeholder="e.g. Large, Strawberry, Red…"
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          {(editDraft.variantName as string)?.trim() &&
                            (() => {
                              const p = allProducts.find(
                                (x: any) => x.id === editDraft.parentProductId,
                              ) as any;
                              return p ? (
                                <p className="mt-1 text-xs text-navy/70 italic">
                                  Name will be: &ldquo;{p.name} -{" "}
                                  {(editDraft.variantName as string).trim()}&rdquo;
                                </p>
                              ) : null;
                            })()}
                        </div>
                      }
                    />
                  )}
                </div>

                {/* Pack-size prompt — suggested from the name/unit while the
                    pack-size field itself is unset. Never guesses: it only
                    pre-fills for HIGH/MEDIUM confidence, states the conflict
                    and leaves the input empty for AMBIGUOUS, and renders
                    nothing at all for a piece-priced unit. */}
                {isEditing &&
                  (() => {
                    const editParent = (editDraft.parentProductId as string)
                      ? allProducts.find((p: any) => p.id === editDraft.parentProductId)
                      : null;
                    // A variant's own stored `name` is just the flavour (e.g.
                    // "Strawberry") — a count that lives in the PARENT's name
                    // (e.g. "Acme Widgets 24ct") would never reach the parser
                    // from the bare name alone. Compose the same
                    // parent + flavor string the name-field preview above
                    // shows so a parent-borne count is still offered — the
                    // AMBIGUOUS refusal below still fires untouched if the
                    // two names disagree on the count.
                    const trimmedVariantName = ((editDraft.variantName as string) ?? "").trim();
                    const classifyName = editParent
                      ? trimmedVariantName
                        ? `${(editParent as any).name} - ${trimmedVariantName}`
                        : (editParent as any).name
                      : ((editDraft.name as string) ?? product.name);
                    return (
                      <PackSizePrompt
                        className="mt-3"
                        name={classifyName}
                        unit={(editDraft.unit as string) ?? product.unit}
                        unitSku={(editDraft.unitSku as string) ?? product.unitSku}
                        unitPrice={parseFloat(String(editDraft.pricePerUnit ?? priceNumber))}
                        unitsPerBox={editDraft.unitsPerBox as string}
                        // Existing product: warn that a pack size re-denominates
                        // the stored on-hand and cost rather than converting them.
                        currentStock={Number(product.currentStock ?? 0)}
                        onAccept={(value) =>
                          setEditDraft((d) => ({ ...d, unitsPerBox: String(value) }))
                        }
                      />
                    );
                  })()}

                {/* Tier Prices */}
                <div className="mt-5 border-t border-surface-border pt-4">
                  <div className="flex items-center justify-between mb-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                      Pricing Tiers
                    </p>
                    {isEditing && (
                      <button
                        type="button"
                        onClick={() => {
                          const t1 = editDraft.pricePerUnit as string;
                          setEditDraft((d) => ({
                            ...d,
                            priceTier2: t1,
                            priceTier3: t1,
                            priceTier4: t1,
                            priceTier5: t1,
                          }));
                        }}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        Set all to {tierLabel(tierLabels, 1)}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {(
                      [
                        [tierLabel(tierLabels, 2), "priceTier2", product.priceTier2],
                        [tierLabel(tierLabels, 3), "priceTier3", product.priceTier3],
                        [tierLabel(tierLabels, 4), "priceTier4", product.priceTier4],
                        [tierLabel(tierLabels, 5), "priceTier5", product.priceTier5],
                      ] as [string, string, any][]
                    ).map(([label, field, productVal], idx) => {
                      const prevFields = ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4"];
                      const prevField = prevFields[idx];
                      const curVal = isEditing
                        ? parseFloat(
                            String(
                              editDraft[field] ?? parseFloat(String(productVal ?? priceNumber)),
                            ),
                          )
                        : parseFloat(String(productVal ?? priceNumber));
                      const prevVal = isEditing
                        ? parseFloat(String(editDraft[prevField] ?? priceNumber))
                        : parseFloat(
                            String(
                              idx === 0
                                ? priceNumber
                                : ((product as any)[prevField] ?? priceNumber),
                            ),
                          );
                      const warn = isEditing && curVal > prevVal;
                      const inheritsList = !(Number(productVal) > 0);
                      return (
                        <div key={field}>
                          <p
                            className={cn(
                              "mb-1 text-xs",
                              warn ? "text-warning font-medium" : "text-navy/70",
                            )}
                          >
                            {label}
                            {warn ? " ⚠" : ""}
                          </p>
                          {isEditing ? (
                            <>
                              <EditableNumber
                                value={curVal}
                                onChange={(v) =>
                                  setEditDraft((d) => ({ ...d, [field]: String(v) }))
                                }
                                onCommit={(v) =>
                                  setEditDraft((d) => ({
                                    ...d,
                                    ...cascadeTierPrices(field as TierField, v),
                                  }))
                                }
                              />
                              {perUnitHint(curVal)}
                            </>
                          ) : (
                            <>
                              <p className="font-mono text-sm font-medium tabular-nums text-navy">
                                ${(inheritsList ? priceNumber : Number(productVal)).toFixed(2)}
                                {inheritsList && (
                                  <span className="ml-1 rounded bg-surface-raised px-1 py-0.5 text-[9px] text-navy/50">
                                    list
                                  </span>
                                )}
                              </p>
                              {perUnitHint(inheritsList ? priceNumber : Number(productVal))}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {isEditing &&
                    (() => {
                      const t1 = parseFloat(String(editDraft.pricePerUnit ?? priceNumber));
                      const t2 = parseFloat(
                        String(editDraft.priceTier2 ?? (product as any).priceTier2 ?? t1),
                      );
                      const t3 = parseFloat(
                        String(editDraft.priceTier3 ?? (product as any).priceTier3 ?? t1),
                      );
                      const t4 = parseFloat(
                        String(editDraft.priceTier4 ?? (product as any).priceTier4 ?? t1),
                      );
                      const t5 = parseFloat(
                        String(editDraft.priceTier5 ?? (product as any).priceTier5 ?? t1),
                      );
                      const hasViolation = t2 > t1 || t3 > t2 || t4 > t3 || t5 > t4;
                      return hasViolation ? (
                        <p className="mt-1.5 text-xs text-warning">
                          Higher tier prices should be ≤ the tier above (volume discounts are
                          lower).
                        </p>
                      ) : null;
                    })()}
                  {isEditing && (
                    <p className="mt-1.5 text-xs text-navy/50">
                      Tiers left at 0 inherit the list price at checkout.
                    </p>
                  )}
                </div>

                {/* MSRP — suggested retail, per PIECE (even for boxed products).
                    Display-only: never feeds pricing/tax/margin math. Flag-gated
                    (flag.msrp) on write; the warning below is advisory only. */}
                <div className="mt-5 border-t border-surface-border pt-4">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                    MSRP (Suggested Retail)
                  </p>
                  {isEditing ? (
                    hasMsrpAddon ? (
                      <>
                        <DecimalInput
                          min={0}
                          value={
                            (editDraft.msrp as string)?.trim()
                              ? parseFloat(editDraft.msrp as string)
                              : null
                          }
                          onChange={(v) =>
                            setEditDraft((d) => ({ ...d, msrp: v == null ? "" : String(v) }))
                          }
                          className="w-32 rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                        <p className="mt-1 text-xs text-navy/50">
                          per piece — even for boxed products
                        </p>
                        {!(editDraft.msrp as string)?.trim() && (
                          <p className="mt-1 text-xs text-navy/50">
                            Shown on new invoices once set — existing invoices keep their original
                            snapshot.
                          </p>
                        )}
                        {msrpBelowWholesale && (
                          <p className="mt-1 text-xs text-warning">
                            Below wholesale price (${wholesalePerPiece.toFixed(2)}/pc)
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-xs italic text-navy/50">Requires the MSRP add-on.</p>
                    )
                  ) : msrpNumber != null ? (
                    <>
                      <p className="font-mono text-sm font-medium tabular-nums text-navy">
                        ${msrpNumber.toFixed(2)}
                        <span className="ml-1 text-[10px] text-navy/50">/pc</span>
                      </p>
                      {msrpBelowWholesale && (
                        <p className="mt-1 text-xs text-warning">
                          Below wholesale price (${wholesalePerPiece.toFixed(2)}/pc)
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-navy/30">—</p>
                  )}
                </div>

                <div className="mt-5 border-t border-surface-border pt-4">
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                    Description
                  </p>
                  {isEditing ? (
                    <textarea
                      value={(editDraft.description as string) ?? ""}
                      onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))}
                      rows={3}
                      className="w-full resize-y rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                  ) : (
                    <p className="text-sm text-navy/80">{product.description}</p>
                  )}
                </div>
              </div>
            </div>

            {/* ── Regulatory reporting ──────────────────────────────────────────
                Filing vocabulary only (regulated type + the codes a report files
                under), kept in its own card so it can't be mistaken for the
                catalog's own unit/packaging fields in Details. Rendered whenever
                the product is regulated, or whenever editing with any regulated
                type available to assign. */}
            {(product.trackedCategory || (isEditing && sectionOptions.length > 0)) && (
              <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
                <div className="flex items-center gap-2 border-b border-surface-border px-5 py-3.5">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-brand-600" />
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                    Regulatory reporting
                  </h3>
                  {product.trackedCategory && (
                    <Link
                      href={`/compliance/${product.trackedCategory.id}`}
                      className="ml-auto text-xs font-medium text-brand-600 hover:underline"
                    >
                      Regulated Items →
                    </Link>
                  )}
                </div>
                <div className="p-5">
                  <p className="mb-4 text-xs text-navy/60">
                    How this product is filed on regulated sales reports. These codes are the filing
                    authority&apos;s vocabulary — separate from the catalog&apos;s own unit of
                    measure and case packaging.
                  </p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                    <InfoRow
                      label="Regulated type"
                      value={
                        isEditing && sectionOptions.length > 0 ? (
                          <select
                            value={(editDraft.trackedCategoryId as string) ?? ""}
                            onChange={(e) => {
                              const trackedCategoryId = e.target.value;
                              setEditDraft((d) => ({
                                ...d,
                                trackedCategoryId,
                                trackedSubcategoryId: "",
                                // Selecting a type replaces the free-text Category
                                // row in Details with the structured combobox —
                                // clear any typed value so a stale one can't
                                // resurface if the type is cleared.
                                category: trackedCategoryId ? "" : d.category,
                                // Regulatory reporting config is scoped to the
                                // section's report template — clear it whenever the
                                // section changes (including cleared entirely) so a
                                // stale code from a different vocabulary can never
                                // be submitted.
                                regItemType: "",
                                regUomCase: "",
                                regUomUnit: "",
                              }));
                            }}
                            className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value="">None (not regulated)</option>
                            {sectionOptions.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                                {s.inactive ? " (inactive)" : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <>
                            {product.trackedCategory?.name ?? "—"}
                            {product.trackedSubcategory && (
                              <span className="text-navy/70">
                                {" "}
                                · {product.trackedSubcategory.name}
                              </span>
                            )}
                          </>
                        )
                      }
                    />
                    {activeProductConfig && (
                      <InfoRow
                        label="Item type"
                        value={
                          isEditing ? (
                            <select
                              value={(editDraft.regItemType as string) ?? ""}
                              onChange={(e) => {
                                const regItemType = e.target.value;
                                setEditDraft((d) => {
                                  const validUoms = uomsForItemType(
                                    activeProductConfig,
                                    regItemType,
                                  ).map((u) => u.code);
                                  return {
                                    ...d,
                                    regItemType,
                                    regUomUnit: validUoms.includes((d.regUomUnit as string) ?? "")
                                      ? d.regUomUnit
                                      : "",
                                    regUomCase: validUoms.includes((d.regUomCase as string) ?? "")
                                      ? d.regUomCase
                                      : "",
                                  };
                                });
                              }}
                              className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                            >
                              <option value="">Select…</option>
                              {activeProductConfig.itemTypes.map((t) => (
                                <option key={t.code} value={t.code}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            regItemTypeLabel(activeProductConfig, product.regItemType)
                          )
                        }
                      />
                    )}
                    {activeProductConfig && (
                      <InfoRow
                        label="Unit of measure (per piece)"
                        value={
                          isEditing ? (
                            <select
                              value={(editDraft.regUomUnit as string) ?? ""}
                              onChange={(e) =>
                                setEditDraft((d) => ({ ...d, regUomUnit: e.target.value }))
                              }
                              disabled={!(editDraft.regItemType as string)}
                              className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-raised disabled:text-navy/40"
                            >
                              <option value="">
                                {(editDraft.regItemType as string)
                                  ? "Select…"
                                  : "Select item type first"}
                              </option>
                              {uomsForItemType(
                                activeProductConfig,
                                (editDraft.regItemType as string) ?? "",
                              ).map((u) => (
                                <option key={u.code} value={u.code}>
                                  {u.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            regUomLabel(activeProductConfig, product.regUomUnit)
                          )
                        }
                      />
                    )}
                    {activeProductConfig?.caseUomSupported && activeUnitsPerBox > 1 && (
                      <InfoRow
                        label="Case unit of measure"
                        value={
                          isEditing ? (
                            <>
                              <select
                                value={(editDraft.regUomCase as string) ?? ""}
                                onChange={(e) =>
                                  setEditDraft((d) => ({ ...d, regUomCase: e.target.value }))
                                }
                                disabled={!(editDraft.regItemType as string)}
                                className="w-full rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-raised disabled:text-navy/40"
                              >
                                <option value="">
                                  {(editDraft.regItemType as string)
                                    ? "Select…"
                                    : "Select item type first"}
                                </option>
                                {uomsForItemType(
                                  activeProductConfig,
                                  (editDraft.regItemType as string) ?? "",
                                ).map((u) => (
                                  <option key={u.code} value={u.code}>
                                    {u.label}
                                  </option>
                                ))}
                              </select>
                              <p className="mt-0.5 text-xs text-navy/70">
                                Used when this product is sold by the case. Leave blank to report
                                every quantity in pieces.
                              </p>
                            </>
                          ) : (
                            regUomLabel(activeProductConfig, product.regUomCase)
                          )
                        }
                      />
                    )}
                  </div>
                  {/* A regulated type whose report template needs no per-product
                      codes (GENERIC, CA_*, CALRECYCLE) would otherwise render an
                      unexplained single-field card. */}
                  {hasActiveRegType && !activeProductConfig && (
                    <p className="mt-4 border-t border-surface-border pt-3 text-xs text-navy/60">
                      This regulated type&apos;s report template needs no per-product item type or
                      unit of measure.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Sales demand — real data from invoiced sales. In its own file (unlike
                CostHistoryCard below) because it owns range/metric state and five
                render states; this file is already ~2.7k lines. */}
            <DemandCard productId={product.id} unitsPerBox={product.unitsPerBox} />

            {/* Sales — per-buyer invoiced-sale history (PR-B): who bought this,
                when, and at what price, with min/avg/max price summary chips. */}
            <SalesHistoryCard productId={product.id} />

            {/* Purchase cost history — real data from PURCHASE / COST_BASIS movements */}
            <CostHistoryCard productId={product.id} />

            {/* Variants section — only for non-variant (parent) products */}
            {!product.parentProductId && (
              <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border px-5 py-3.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                    Variants
                  </h3>
                  {isOperator && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<Scissors className="h-3.5 w-3.5" />}
                        onClick={() => setShowVariantSplit(true)}
                      >
                        Assign to variants
                      </Button>
                      <Button size="sm" variant="secondary" onClick={openLinkExistingModal}>
                        Link existing
                      </Button>
                      <Button
                        size="sm"
                        leftIcon={<Plus className="h-3.5 w-3.5" />}
                        onClick={() => openVariantModal()}
                      >
                        Add Variant
                      </Button>
                    </div>
                  )}
                </div>

                {(!product.variants || product.variants.length === 0) && !product.variantName ? (
                  <p className="text-sm text-navy/70 text-center py-10">
                    No variants yet. Add flavors, sizes, or other variations.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left">
                          <th className="border-b-2 border-navy px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            Variant
                          </th>
                          <th className="border-b-2 border-navy px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            SKU
                          </th>
                          <th className="border-b-2 border-navy px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            {tierLabel(tierLabels, 1)}
                          </th>
                          <th className="border-b-2 border-navy px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            {tierLabel(tierLabels, 2)}
                          </th>
                          <th className="border-b-2 border-navy px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                            Status
                          </th>
                          {isOperator && (
                            <th className="border-b-2 border-navy px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.07em] text-navy/70">
                              Actions
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {/* Parent product itself as first row */}
                        <tr className="border-b border-surface-border bg-surface-raised/30">
                          <td className="px-5 py-2.5">
                            <span className="font-medium text-navy">
                              {product.variantName || (
                                <span className="italic text-navy/70">this product</span>
                              )}
                            </span>
                            {!product.variantName && isOperator && (
                              <button
                                onClick={startEdit}
                                className="ml-2 text-xs text-brand-500 hover:underline"
                              >
                                assign name
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-navy/70">
                            {product.sku || <span className="text-navy/30">&mdash;</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-navy">
                            ${priceNumber.toFixed(2)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums text-navy">
                            ${getTierPrice(product, 2).toFixed(2)}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge
                              variant={product.isActive ? "success" : "neutral"}
                              label={product.isActive ? "Active" : "Inactive"}
                            />
                          </td>
                          {isOperator && (
                            <td className="px-5 py-2.5 text-right">
                              <button
                                onClick={startEdit}
                                title="Edit this product"
                                className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                        {(product.variants ?? []).map((variant: ApiProduct) => (
                          <tr
                            key={variant.id}
                            className="border-b border-surface-border last:border-0"
                          >
                            <td className="px-5 py-2.5">
                              <Link
                                href={`/products/${variant.id}`}
                                className="font-medium text-brand-600 hover:underline"
                              >
                                {variant.variantName || variant.name}
                              </Link>
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-navy/70">
                              {variant.sku || <span className="text-navy/30">&mdash;</span>}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-navy">
                              ${parseFloat(String(variant.pricePerUnit)).toFixed(2)}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-navy">
                              ${getTierPrice(variant, 2).toFixed(2)}
                            </td>
                            <td className="px-3 py-2.5">
                              <Badge
                                variant={variant.isActive ? "success" : "neutral"}
                                label={variant.isActive ? "Active" : "Inactive"}
                              />
                            </td>
                            {isOperator && (
                              <td className="px-5 py-2.5">
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    onClick={() => openVariantModal(variant)}
                                    title="Edit variant"
                                    className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleToggleVariantActive(variant)}
                                    title={variant.isActive ? "Deactivate" : "Reactivate"}
                                    className={cn(
                                      "rounded p-1.5 transition-colors",
                                      variant.isActive
                                        ? "text-navy/70 hover:bg-warning-bg hover:text-warning"
                                        : "text-navy/70 hover:bg-success-bg hover:text-success",
                                    )}
                                  >
                                    <Power className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Variant Add/Edit Modal */}
      <Modal
        open={variantModalOpen}
        onClose={closeVariantModal}
        title={editingVariant ? "Edit Variant" : "Add Variant"}
        footer={
          <>
            <Button variant="secondary" onClick={closeVariantModal}>
              Cancel
            </Button>
            <Button
              onClick={handleVariantSubmit}
              loading={createProduct.isPending || updateProduct.isPending}
            >
              {editingVariant ? "Save Changes" : "Create Variant"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Variant Name <span className="text-danger">*</span>
            </label>
            <input
              value={variantForm.variantName}
              onChange={(e) => setVariantForm((f) => ({ ...f, variantName: e.target.value }))}
              placeholder='e.g. "Chocolate", "Large", "500ml"'
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">SKU</label>
            <div className="flex gap-2">
              <input
                ref={variantSkuRef}
                value={variantForm.sku}
                onChange={(e) => setVariantForm((f) => ({ ...f, sku: e.target.value }))}
                placeholder="Optional SKU or barcode"
                className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <BarcodeScannerButton
                onScan={(code) => setVariantForm((f) => ({ ...f, sku: code }))}
                inputRef={variantSkuRef}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">Unit code</label>
            <div className="flex gap-2">
              <input
                ref={variantUnitSkuRef}
                value={variantForm.unitSku}
                onChange={(e) => setVariantForm((f) => ({ ...f, unitSku: e.target.value }))}
                placeholder="Leave blank if it matches the case code"
                className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <BarcodeScannerButton
                onScan={(code) => setVariantForm((f) => ({ ...f, unitSku: code }))}
                inputRef={variantUnitSkuRef}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">Pricing Tiers</label>
            <div className="grid grid-cols-5 gap-2">
              {(
                [
                  ["price", 1, "T1 (List)"],
                  ["priceTier2", 2, "T2"],
                  ["priceTier3", 3, "T3"],
                  ["priceTier4", 4, "T4"],
                  ["priceTier5", 5, "T5"],
                ] as [keyof typeof variantForm, number, string][]
              ).map(([field, tier, fallbackLabel], idx) => {
                // Compact grid heading — swap in a configured tier name when the tenant
                // set one, else keep the existing "T1 (List)".."T5" abbreviation (these
                // cells are narrow), same posture as the products list tier columns.
                const label = tierLabels?.[String(tier)]?.trim() || fallbackLabel;
                const val = parseFloat(variantForm[field]) || 0;
                const prevField =
                  idx > 0
                    ? (["price", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const)[
                        idx - 1
                      ]
                    : null;
                const prevVal = prevField ? parseFloat(variantForm[prevField]) || 0 : Infinity;
                const warn = idx > 0 && val > prevVal;
                return (
                  <div key={field}>
                    <p className="mb-1 text-xs text-navy/70">{label}</p>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={variantForm[field]}
                      onChange={(e) => setVariantForm((f) => ({ ...f, [field]: e.target.value }))}
                      className={cn(
                        "w-full rounded border px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500",
                        warn ? "border-warning text-warning" : "border-surface-border",
                      )}
                    />
                    {warn && (
                      <p className="mt-0.5 text-xs text-warning">
                        Higher than {tierLabels?.[String(idx)]?.trim() || `T${idx}`}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-navy/70">
              Higher tiers (volume) are typically equal to or lower than {tierLabel(tierLabels, 1)}.
            </p>
          </div>

          {!editingVariant && (
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/70">Unit</label>
              <input
                value={variantForm.unit}
                onChange={(e) => setVariantForm((f) => ({ ...f, unit: e.target.value }))}
                placeholder={product.unit}
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          )}
        </div>
      </Modal>

      {/* ── Make Variant Of Modal ── */}
      <Modal
        open={makeVariantOpen}
        onClose={() => setMakeVariantOpen(false)}
        title="Make variant of…"
        footer={
          <>
            <Button variant="secondary" onClick={() => setMakeVariantOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleMakeVariantSubmit} loading={updateProduct.isPending}>
              Link as variant
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-navy/70">
            Link <span className="font-medium text-navy">{product.name}</span> as a variant (flavor,
            size, etc.) of another product. The product name will be updated to match the parent.
          </p>

          {/* Parent selection */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Parent product <span className="text-danger">*</span>
            </label>
            <div className="flex gap-2">
              <select
                value={makeVariantParentId}
                onChange={(e) => setMakeVariantParentId(e.target.value)}
                className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">— Select a product —</option>
                {allProducts
                  .filter((p: any) => !p.parentProductId && p.id !== params.id)
                  .map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <BarcodeScannerButton
                onScan={handleMakeVariantScan}
                title="Scan another product's barcode to auto-select it as the parent"
              />
            </div>
            {makeVariantScanLoading && (
              <p className="mt-1 text-xs text-navy/70">Looking up product…</p>
            )}
          </div>

          {/* Flavor / variety name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Flavor / variety <span className="text-danger">*</span>
            </label>
            <input
              value={makeVariantName}
              onChange={(e) => setMakeVariantName(e.target.value)}
              placeholder='e.g. "Chocolate", "Large", "500ml"'
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {/* If parent has no variantName yet, ask for one */}
          {makeVariantParentId &&
            (() => {
              const parent = allProducts.find((p: any) => p.id === makeVariantParentId) as any;
              if (!parent || parent.variantName) return null;
              return (
                <div>
                  <label className="mb-1 block text-xs font-medium text-navy/70">
                    Variant name for <span className="text-navy">{parent.name}</span>
                    <span className="ml-1 text-navy/70">(optional)</span>
                  </label>
                  <input
                    value={makeVariantParentOwnName}
                    onChange={(e) => setMakeVariantParentOwnName(e.target.value)}
                    placeholder='e.g. "Original", "Regular", "Standard"'
                    className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <p className="mt-1 text-xs text-navy/70">
                    Since {parent.name} doesn&apos;t have a variant name, you can assign one now so
                    it appears alongside its variants.
                  </p>
                </div>
              );
            })()}

          {/* Preview of composed name */}
          {makeVariantParentId &&
            makeVariantName.trim() &&
            (() => {
              const parent = allProducts.find((p: any) => p.id === makeVariantParentId) as any;
              return parent ? (
                <div className="rounded bg-surface-raised px-3 py-2 text-xs text-navy/70 space-y-0.5">
                  <p>
                    This product:{" "}
                    <span className="font-medium text-navy">
                      {parent.name} - {makeVariantName.trim()}
                    </span>
                  </p>
                  {makeVariantParentOwnName.trim() && !parent.variantName && (
                    <p>
                      {parent.name}:{" "}
                      <span className="font-medium text-navy">
                        {parent.name} - {makeVariantParentOwnName.trim()}
                      </span>
                    </p>
                  )}
                </div>
              ) : null;
            })()}
        </div>
      </Modal>

      {/* ── Link Existing Product as Variant Modal ── */}
      <Modal
        open={linkExistingOpen}
        onClose={() => setLinkExistingOpen(false)}
        title="Link existing product as variant"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLinkExistingOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleLinkExistingSubmit} loading={updateProduct.isPending}>
              Link as variant
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-navy/70">
            Pick an existing standalone product to adopt as a variant of{" "}
            <span className="font-medium text-navy">{product.name}</span>.
          </p>

          {/* Searchable product list */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Product <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              placeholder="Search by name or SKU…"
              value={linkExistingSearch}
              onChange={(e) => setLinkExistingSearch(e.target.value)}
              className="mb-2 w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <div className="max-h-40 overflow-y-auto rounded border border-surface-border">
              {filteredLinkCandidates.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-navy/70">
                  No matching standalone products.
                </p>
              ) : (
                filteredLinkCandidates.map((p: any) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setLinkExistingProductId(p.id)}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised transition-colors",
                      linkExistingProductId === p.id && "bg-brand-50 ring-1 ring-brand-300",
                    )}
                  >
                    <div>
                      <span className="font-medium text-navy">{p.name}</span>
                      {p.sku && <span className="ml-2 text-xs text-navy/70">{p.sku}</span>}
                    </div>
                    <span className="text-xs text-navy/70">
                      ${parseFloat(String(p.pricePerUnit)).toFixed(2)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Variant / flavor name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Flavor / variety <span className="text-danger">*</span>
            </label>
            <input
              value={linkExistingVariantName}
              onChange={(e) => setLinkExistingVariantName(e.target.value)}
              placeholder='e.g. "Chocolate", "Large", "500ml"'
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {/* If this (parent) product has no variantName yet, ask for one */}
          {!product.variantName && (
            <div>
              <label className="mb-1 block text-xs font-medium text-navy/70">
                Variant name for <span className="text-navy">{product.name}</span>
                <span className="ml-1 text-navy/70">(optional)</span>
              </label>
              <input
                value={linkExistingParentVariantName}
                onChange={(e) => setLinkExistingParentVariantName(e.target.value)}
                placeholder='e.g. "Original", "Regular", "Standard"'
                className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="mt-1 text-xs text-navy/70">
                Assign a variant name to this product too, so both appear in the variants table with
                their own identifiers.
              </p>
            </div>
          )}

          {/* Name preview */}
          {linkExistingProductId && linkExistingVariantName.trim() && (
            <div className="rounded bg-surface-raised px-3 py-2 text-xs text-navy/70 space-y-0.5">
              <p>
                Selected product:{" "}
                <span className="font-medium text-navy">
                  {product.name} - {linkExistingVariantName.trim()}
                </span>
              </p>
              {linkExistingParentVariantName.trim() && !product.variantName && (
                <p>
                  This product:{" "}
                  <span className="font-medium text-navy">
                    {product.name} - {linkExistingParentVariantName.trim()}
                  </span>
                </p>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
