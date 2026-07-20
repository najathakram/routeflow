"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Package,
  LayoutGrid,
  LayoutList,
  Plus,
  Trash2,
  X as XIcon,
  CheckSquare,
  Pencil,
  Check,
  Undo2,
  Redo2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Layers,
} from "lucide-react";
import { PageHeader, Table, Badge, Button, Select, cn, EmptyState } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useDebounce } from "@/lib/hooks/useDebounce";
import { useUrlFilters } from "@/lib/hooks/useUrlFilters";
import { useProducts, useUpdateProduct, useBulkDeleteProducts } from "@/lib/api/products";
import { useTrackedCategories, type TrackedCategory } from "@/lib/api/tracked-categories";
import { objectPositionForUrl } from "@/lib/image-focal";
import { GroupAsVariantsModal } from "@/components/GroupAsVariantsModal";
import { ProductCreateModal } from "@/components/ProductCreateModal";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { AssignToSectionModal } from "@/components/AssignToSectionModal";
import { RegulatedScopeTabs } from "@/components/RegulatedScopeTabs";
import { QuickEditCell, type EditRecord } from "./_components/QuickEditCell";
import { SectionEditCell } from "./_components/SectionEditCell";

// ─── Types ────────────────────────────────────────────────────────────────────

type StockStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK";

interface ApiProduct {
  id: string;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit: string;
  pricePerUnit: string;
  priceTier2?: string;
  priceTier3?: string;
  priceTier4?: string;
  priceTier5?: string;
  isActive: boolean;
  currentStock: number;
  averageCost?: string;
  description?: string;
  thumbnailUrl?: string | null;
  costingMethod?: string;
  standardCost?: string | number;
  unitsPerBox?: number | null;
  parentProductId?: string | null;
  variantName?: string | null;
  variants?: ApiProduct[];
  parent?: ApiProduct | null;
  isFeatured?: boolean;
  isNew?: boolean;
  isDeal?: boolean;
  /** Regulated section + subcategory tags (Phase 4 / section isolation). */
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
}

// Merchandising badge row (P5-01) — reused by grid card + table cell.
function MerchBadges({ product }: { product: ApiProduct }) {
  if (!product.isFeatured && !product.isNew && !product.isDeal) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {product.isFeatured && (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-brand-50 text-brand-700 ring-1 ring-brand-200">
          Featured
        </span>
      )}
      {product.isNew && (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-sky-100 text-sky-800">
          New
        </span>
      )}
      {product.isDeal && (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-100 text-emerald-800">
          Deal
        </span>
      )}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStockStatus(p: ApiProduct): StockStatus {
  if (!p.isActive) return "OUT_OF_STOCK";
  if (p.currentStock <= 0) return "OUT_OF_STOCK";
  if (p.currentStock <= 5) return "LOW";
  return "IN_STOCK";
}

// ─── Stock badge ──────────────────────────────────────────────────────────────

function StockBadge({ status }: { status: StockStatus }) {
  if (status === "OUT_OF_STOCK") return <Badge variant="danger" label="Out of Stock" />;
  if (status === "LOW") return <Badge variant="warning" label="Low Stock" />;
  return <Badge variant="success" label="In Stock" />;
}

// ─── Product grid card ────────────────────────────────────────────────────────

function ProductCard({
  product,
  onClick,
  selected,
  onSelect,
  selectionMode,
  onAddVariant,
  sectionNameById,
}: {
  product: ApiProduct;
  onClick: () => void;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  selectionMode: boolean;
  onAddVariant?: (parentId: string) => void;
  sectionNameById: Map<string, string>;
}) {
  const status = getStockStatus(product);
  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border bg-white text-left shadow-card transition-shadow hover:shadow-dropdown cursor-pointer",
        status === "LOW" && "border-warning/40",
        status === "OUT_OF_STOCK" && "border-danger/40",
        status === "IN_STOCK" && "border-surface-border",
        selected && "ring-2 ring-brand-500 border-brand-500",
      )}
      onClick={selectionMode ? onSelect : onClick}
    >
      {/* Checkbox — only visible in selection mode */}
      {selectionMode && (
        <div
          className="absolute left-2 top-2 z-10"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(e);
          }}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={() => {}}
            className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
          />
        </div>
      )}

      {/* Thumbnail / image placeholder */}
      <div
        className={cn(
          "relative flex h-28 w-full items-center justify-center overflow-hidden",
          status === "LOW" && "bg-warning-bg",
          status === "OUT_OF_STOCK" && "bg-danger-bg",
          status === "IN_STOCK" && "bg-surface-raised",
        )}
        onClick={selectionMode ? undefined : onClick}
      >
        {product.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.thumbnailUrl}
            alt={product.name}
            className="h-full w-full object-cover"
            style={{ objectPosition: objectPositionForUrl(product.thumbnailUrl) }}
            draggable={false}
          />
        ) : (
          <Package
            className={cn(
              "h-10 w-10",
              status === "LOW" && "text-warning/40",
              status === "OUT_OF_STOCK" && "text-danger/40",
              status === "IN_STOCK" && "text-navy/20",
            )}
          />
        )}
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col gap-2 p-3" onClick={selectionMode ? undefined : onClick}>
        <div>
          <p className="font-mono text-[11px] text-navy/40">{product.sku}</p>
          <p className="mt-0.5 text-sm font-semibold leading-snug text-navy line-clamp-2">
            {/* Variants display just their flavor / variety name. Parent
                context is rendered below as a small caption. Falls back to
                full `name` for variants whose row still has the legacy
                "Parent - Variant" composite name (pre-fix data). */}
            {product.variantName ?? product.name}
          </p>
        </div>
        <div className="mt-auto flex items-end justify-between gap-1">
          <p className="font-mono tabular-nums text-base font-bold text-navy">
            ${parseFloat(String(product.pricePerUnit)).toFixed(2)}
            <span className="ml-1 font-sans text-xs font-normal text-navy/70">
              / {product.unit}
            </span>
          </p>
          {product.variants && product.variants.length > 0 && (
            <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-600 ring-1 ring-brand-200">
              {product.variants.length} var.
            </span>
          )}
        </div>
        {/* Variant indicator */}
        {product.variantName && product.parent && (
          <p className="text-[10px] text-navy/70 truncate">{product.parent.name}</p>
        )}
        <div className="flex items-center gap-1.5">
          <StockBadge status={status} />
          <MerchBadges product={product} />
          {product.trackedCategoryId && (
            <span
              title={
                (product as any).trackedSubcategory?.name ??
                sectionNameById.get(product.trackedCategoryId) ??
                "Section"
              }
              className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700"
            >
              {sectionNameById.get(product.trackedCategoryId) ?? "Section"}
            </span>
          )}
        </div>
        {/* Add variant button for parent products */}
        {product.variants && product.variants.length > 0 && onAddVariant && !selectionMode && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddVariant(product.id);
            }}
            className="mt-1 flex items-center gap-1 text-[10px] text-navy/70 hover:text-brand-500 transition-colors"
          >
            <Plus className="h-2.5 w-2.5" />
            Add variant
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Table column defs ────────────────────────────────────────────────────────

function makeTableColumns(
  selected: Set<string>,
  onToggle: (id: string) => void,
  allIds: string[],
  onToggleAll: () => void,
  selectMode: boolean,
  onEditPrice: (product: ApiProduct) => void,
  editingPriceId: string | null,
  editPriceValue: string,
  onEditPriceChange: (v: string) => void,
  onEditPriceSave: (id: string) => void,
  onEditPriceCancel: () => void,
  quickEditMode: boolean,
  onQuickSave: (
    product: ApiProduct,
    field: string,
    newVal: string,
    record: EditRecord,
  ) => Promise<void>,
  barcodeRefs: React.MutableRefObject<Record<string, React.RefObject<HTMLInputElement | null>>>,
  productIds: string[],
  categories: string[],
  sectionNameById: Map<string, string>,
  activeSections: TrackedCategory[],
  hasSections: boolean,
  onSectionSave: (
    product: ApiProduct,
    patch: { trackedCategoryId: string | null; trackedSubcategoryId: string | null },
    prior: { trackedCategoryId: string | null; trackedSubcategoryId: string | null },
  ) => void,
): ColumnDef<ApiProduct, unknown>[] {
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = !allSelected && allIds.some((id) => selected.has(id));

  const sectionCol: ColumnDef<ApiProduct, unknown> = {
    id: "section",
    header: "Section",
    enableSorting: false,
    cell: ({ row }) => {
      const p = row.original;
      if (quickEditMode) {
        return (
          <div onClick={(e) => e.stopPropagation()}>
            <SectionEditCell
              productId={p.id}
              trackedCategoryId={p.trackedCategoryId ?? null}
              trackedSubcategoryId={p.trackedSubcategoryId ?? null}
              activeSections={activeSections}
              sectionNameById={sectionNameById}
              onSave={(patch) =>
                onSectionSave(p, patch, {
                  trackedCategoryId: p.trackedCategoryId ?? null,
                  trackedSubcategoryId: p.trackedSubcategoryId ?? null,
                })
              }
            />
          </div>
        );
      }
      if (!p.trackedCategoryId) {
        return <span className="text-xs text-navy/30">—</span>;
      }
      const sectionName = sectionNameById.get(p.trackedCategoryId) ?? "Section";
      return (
        <span
          title={(p as any).trackedSubcategory?.name ?? sectionName}
          className="inline-flex items-center rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700"
        >
          {sectionName}
        </span>
      );
    },
  };

  const selectCol: ColumnDef<ApiProduct, unknown> = {
    id: "select",
    header: () => (
      <input
        type="checkbox"
        checked={allSelected}
        ref={(el) => {
          if (el) el.indeterminate = someSelected;
        }}
        onChange={onToggleAll}
        className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
      />
    ),
    cell: ({ row }) => (
      <input
        type="checkbox"
        checked={selected.has(row.original.id)}
        onChange={() => onToggle(row.original.id)}
        onClick={(e) => e.stopPropagation()}
        className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
      />
    ),
    enableSorting: false,
    size: 40,
  };

  return [
    ...(selectMode ? [selectCol] : []),
    {
      accessorKey: "name",
      header: "Product",
      cell: ({ row }) => {
        const p = row.original;
        const status = getStockStatus(p);
        return (
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-11 w-9 flex-none items-center justify-center overflow-hidden rounded-md border",
                status === "LOW"
                  ? "border-warning/40 bg-warning-bg"
                  : status === "OUT_OF_STOCK"
                    ? "border-danger/40 bg-danger-bg"
                    : "border-surface-border bg-surface-raised",
              )}
            >
              {p.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.thumbnailUrl}
                  alt={p.name}
                  className="h-full w-full object-cover"
                  style={{ objectPosition: objectPositionForUrl(p.thumbnailUrl) }}
                  draggable={false}
                />
              ) : (
                <Package className="h-4 w-4 text-navy/20" />
              )}
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-navy">
                {p.name}
                {(p as any).isTobacco && (
                  <span
                    title="Tobacco product — tracked separately for monthly tax reports"
                    className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800"
                  >
                    tobacco
                  </span>
                )}
                <span className="ml-2 inline-flex align-middle">
                  <MerchBadges product={p} />
                </span>
              </p>
              <p className="text-[11px] text-navy/40">
                {p.sku ? `${p.sku} · ` : ""}
                {p.unitsPerBox && p.unitsPerBox > 1 ? "box + piece" : p.unit}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: "sku",
      header: "SKU / Barcode",
      cell: ({ row }) => {
        const p = row.original;
        const idx = productIds.indexOf(p.id);
        const nextId = productIds[idx + 1];
        const nextRef = nextId ? barcodeRefs.current[nextId] : undefined;
        const thisRef = (barcodeRefs.current[p.id] ??= React.createRef());
        return (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <QuickEditCell
              ref={thisRef}
              productId={p.id}
              productName={p.name}
              field="sku"
              value={p.sku}
              placeholder="Scan or type SKU…"
              quickEditMode={quickEditMode}
              nextInputRef={nextRef}
              onSave={(val, rec) => onQuickSave(p, "sku", val, rec)}
            />
            {quickEditMode && (
              <BarcodeScannerButton
                inputRef={thisRef}
                onScan={async (code) => {
                  await onQuickSave(p, "sku", code, {
                    productId: p.id,
                    productName: p.name,
                    field: "sku",
                    oldValue: p.sku ?? null,
                    newValue: code,
                  });
                  // Jump to next row after camera scan
                  if (nextRef?.current) {
                    nextRef.current.focus();
                    nextRef.current.select();
                  }
                }}
                title="Scan with camera"
              />
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "category",
      header: "Category",
      cell: ({ row }) => {
        const p = row.original;
        return (
          <div onClick={(e) => e.stopPropagation()}>
            <QuickEditCell
              productId={p.id}
              productName={p.name}
              field="category"
              value={p.category}
              options={categories}
              placeholder="Select or add category…"
              quickEditMode={quickEditMode}
              onSave={(val, rec) => onQuickSave(p, "category", val, rec)}
            />
          </div>
        );
      },
    },
    ...(hasSections ? [sectionCol] : []),
    {
      accessorKey: "unit",
      header: "Unit",
      enableSorting: false,
      cell: ({ row }) => <span className="text-navy">{row.original.unit}</span>,
    },
    {
      accessorKey: "pricePerUnit",
      header: "Price",
      cell: ({ row }) => {
        const p = row.original;
        if (editingPriceId === p.id) {
          return (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <span className="text-sm text-navy/70">$</span>
              <input
                autoFocus
                type="number"
                min="0"
                step="0.01"
                value={editPriceValue}
                onChange={(e) => onEditPriceChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onEditPriceSave(p.id);
                  if (e.key === "Escape") onEditPriceCancel();
                }}
                className="w-20 rounded border border-brand-500 px-1.5 py-0.5 text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <button
                onClick={() => onEditPriceSave(p.id)}
                className="text-success hover:text-success/70 transition-colors"
                title="Save"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={onEditPriceCancel}
                className="text-navy/70 hover:text-navy transition-colors"
                title="Cancel"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        }
        return (
          <div className="group flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <span className="font-mono tabular-nums font-medium text-navy">
              ${parseFloat(String(p.pricePerUnit)).toFixed(2)}
            </span>
            <button
              onClick={() => onEditPrice(p)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-navy/70 hover:text-brand-500"
              title="Edit price"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        );
      },
    },
    {
      accessorKey: "averageCost",
      header: "Avg Cost",
      cell: ({ row }) => {
        const p = row.original;
        const cost = p.averageCost != null ? parseFloat(String(p.averageCost)) : null;
        if (cost == null) {
          return (
            <span
              title="No cost basis recorded — set one from Inventory → Set Costs, or receive a purchase"
              className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
            >
              No cost set
            </span>
          );
        }
        return <span className="font-mono tabular-nums text-navy/70">{`$${cost.toFixed(2)}`}</span>;
      },
    },
    {
      accessorKey: "unitsPerBox",
      header: "Per Box",
      enableSorting: false,
      cell: ({ row }) => {
        const p = row.original;
        if (quickEditMode) {
          return (
            <QuickEditCell
              productId={p.id}
              productName={p.name}
              field="unitsPerBox"
              value={p.unitsPerBox != null ? String(p.unitsPerBox) : ""}
              quickEditMode={quickEditMode}
              onSave={(val, rec) => onQuickSave(p, "unitsPerBox", val, rec)}
            />
          );
        }
        return <span className="text-navy/70">{p.unitsPerBox ?? "—"}</span>;
      },
    },
    // Tier price columns — always shown, editable only in Quick Edit mode
    ...[2, 3, 4, 5].map((tier) => ({
      id: `priceTier${tier}`,
      header: `T${tier}`,
      enableSorting: false,
      cell: ({ row }: any) => {
        const p = row.original;
        const tierKey = `priceTier${tier}` as keyof ApiProduct;
        const val = p[tierKey] as string | undefined;
        if (quickEditMode) {
          return (
            <QuickEditCell
              productId={p.id}
              productName={p.name}
              field={`priceTier${tier}`}
              value={val ? parseFloat(String(val)).toFixed(2) : ""}
              quickEditMode={quickEditMode}
              onSave={async (newVal, rec) => {
                await onQuickSave(p, `priceTier${tier}`, newVal || "0", rec);
              }}
            />
          );
        }
        // Normal view: read-only display
        return (
          <span className="font-mono tabular-nums text-sm text-navy/70">
            {val && parseFloat(String(val)) > 0 ? (
              `$${parseFloat(String(val)).toFixed(2)}`
            ) : (
              <span className="text-navy/30">—</span>
            )}
          </span>
        );
      },
    })),
    {
      accessorKey: "currentStock",
      header: "Stock",
      cell: ({ row }) => {
        const status = getStockStatus(row.original);
        return (
          <div className="flex items-center gap-2">
            <StockBadge status={status} />
            <span className="text-xs text-navy/70">
              {Number(row.original.currentStock).toFixed(0)} {row.original.unit}
            </span>
          </div>
        );
      },
    },
  ];
}

// ─── Page ─────────────────────────────────────────────────────────────────────
// (The former inline "Create product modal" here now lives at
// components/ProductCreateModal.tsx, shared with the scan surfaces.)

export default function ProductsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => {
    setTitle("Products");
  }, [setTitle]);

  // Auto-open the create modal from a deep link (e.g. /products?action=new,
  // the target of the /products/create redirect stub).
  React.useEffect(() => {
    if (searchParams.get("action") === "new") setShowCreate(true);
  }, [searchParams]);

  const [search, setSearch] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [stockFilter, setStockFilter] = React.useState("");
  // Regulated-section filter is the one deep-linkable filter (?section=) — the
  // Compliance hub's per-section KPI links here.
  const [urlFilters, setUrlFilter] = useUrlFilters({ section: "" });
  const sectionFilter = urlFilters.section;
  const [viewMode, setViewMode] = React.useState<"grid" | "table">("grid");
  const [showCreate, setShowCreate] = React.useState(false);
  const [newVariantParentId, setNewVariantParentId] = React.useState<string | undefined>(undefined);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = React.useState(false);
  const [showGroupAsVariants, setShowGroupAsVariants] = React.useState(false);
  const [showAssignToSection, setShowAssignToSection] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const updateProduct = useUpdateProduct();
  const bulkDelete = useBulkDeleteProducts();

  // Section names must resolve for deactivated sections too (a product can still
  // carry a tag whose section was since deactivated), so this fetch is
  // UNFILTERED — `activeSections` below is what feeds pickers/dropdowns.
  const { data: allSections = [] } = useTrackedCategories();
  const sectionNameById = React.useMemo(
    () => new Map(allSections.map((c) => [c.id, c.name])),
    [allSections],
  );
  const activeSections = React.useMemo(() => allSections.filter((c) => c.active), [allSections]);
  const hasSections = allSections.length > 0;

  const [editingPriceId, setEditingPriceId] = React.useState<string | null>(null);
  const [editPriceValue, setEditPriceValue] = React.useState("");

  // ── Quick Edit Mode & undo/redo ───────────────────────────────────────────
  const [quickEditMode, setQuickEditMode] = React.useState(false);
  const [undoStack, setUndoStack] = React.useState<EditRecord[]>([]);
  const [redoStack, setRedoStack] = React.useState<EditRecord[]>([]);
  // Refs map for barcode scanner row-jump: productId → ref of its barcode input
  const barcodeRefs = React.useRef<Record<string, React.RefObject<HTMLInputElement | null>>>({});

  const handleQuickSave = React.useCallback(
    async (product: ApiProduct, field: string, newVal: string, record: EditRecord) => {
      const updates: { id: string; [k: string]: unknown } = {
        id: product.id,
        [field]: newVal || null,
      };

      // Auto-copy pricePerUnit to all tiers if they were all the same as the old price
      if (field === "pricePerUnit" && newVal) {
        const newPrice = parseFloat(newVal);
        const oldPrice = parseFloat(String(product.pricePerUnit)).toFixed(2);
        const allSameAsOld = [
          product.priceTier2,
          product.priceTier3,
          product.priceTier4,
          product.priceTier5,
        ].every(
          (t) =>
            !t ||
            parseFloat(String(t)).toFixed(2) === oldPrice ||
            parseFloat(String(t)).toFixed(2) === "0.00",
        );
        if (allSameAsOld) {
          updates.priceTier2 = newVal;
          updates.priceTier3 = newVal;
          updates.priceTier4 = newVal;
          updates.priceTier5 = newVal;
        } else {
          // Cascade cap: higher tiers that are MORE expensive than T1 get capped
          for (let m = 2; m <= 5; m++) {
            const key = `priceTier${m}` as keyof ApiProduct;
            const tierVal = product[key];
            const tierPrice = tierVal ? parseFloat(String(tierVal)) : 0;
            if (!tierVal || tierPrice > newPrice) {
              updates[`priceTier${m}`] = newVal;
            }
          }
        }
      }

      // Cascade tier prices: when saving priceTierN, cap all higher tiers that are more expensive
      if (field.startsWith("priceTier") && newVal) {
        const tier = parseInt(field.replace("priceTier", ""), 10); // 2,3,4,5
        const newPrice = parseFloat(newVal);
        for (let m = tier + 1; m <= 5; m++) {
          const key = `priceTier${m}` as keyof ApiProduct;
          const tierVal = product[key];
          const tierPrice = tierVal ? parseFloat(String(tierVal)) : 0;
          if (!tierVal || tierPrice > newPrice) {
            updates[`priceTier${m}`] = newVal;
          }
        }
      }

      await updateProduct.mutateAsync(updates);
      toast({ title: `${field} updated`, variant: "success" });
      setUndoStack((prev) => [...prev.slice(-19), record]);
      setRedoStack([]);
    },
    [updateProduct, toast],
  );

  // Regulated section + subcategory save from the Section Quick-Edit cell — an
  // object patch (both fields together in one update) rather than the single
  // scalar the other Quick-Edit fields save. Takes the full product (like
  // handleQuickSave) rather than just an id, so it doesn't need to look the row
  // up in `productList` — which is declared further down this component and
  // would otherwise force this callback's deps array to forward-reference it.
  const handleSectionSave = React.useCallback(
    async (
      product: ApiProduct,
      patch: { trackedCategoryId: string | null; trackedSubcategoryId: string | null },
      prior: { trackedCategoryId: string | null; trackedSubcategoryId: string | null },
    ) => {
      await updateProduct.mutateAsync({ id: product.id, ...patch });
      toast({ title: "Section updated", variant: "success" });
      setUndoStack((prev) => [
        ...prev.slice(-19),
        {
          productId: product.id,
          productName: product.name,
          field: "section",
          oldValue: prior,
          newValue: patch,
        },
      ]);
      setRedoStack([]);
    },
    [updateProduct, toast],
  );

  const handleUndo = async () => {
    const record = undoStack[undoStack.length - 1];
    if (!record) return;
    const value = record.oldValue;
    const patch =
      record.field === "section" ? (value as Record<string, unknown>) : { [record.field]: value };
    await updateProduct.mutateAsync({ id: record.productId, ...patch });
    toast({ title: `Undone: ${record.productName} · ${record.field}`, variant: "success" });
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, record]);
  };

  const handleRedo = async () => {
    const record = redoStack[redoStack.length - 1];
    if (!record) return;
    const value = record.newValue;
    const patch =
      record.field === "section" ? (value as Record<string, unknown>) : { [record.field]: value };
    await updateProduct.mutateAsync({ id: record.productId, ...patch });
    toast({ title: `Redone: ${record.productName} · ${record.field}`, variant: "success" });
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, record]);
  };

  const handleEditPrice = (product: ApiProduct) => {
    setEditingPriceId(product.id);
    setEditPriceValue(parseFloat(String(product.pricePerUnit)).toFixed(2));
  };

  const handleEditPriceSave = async (id: string) => {
    if (!editPriceValue) return;
    try {
      // Find the product to check if tiers should auto-copy
      const product = productList.find((p: ApiProduct) => p.id === id);
      const newPriceStr = parseFloat(editPriceValue).toFixed(2);
      const newPrice = parseFloat(newPriceStr);
      const updates: { id: string; [k: string]: unknown } = { id, pricePerUnit: newPriceStr };
      if (product) {
        const oldPrice = parseFloat(String(product.pricePerUnit)).toFixed(2);
        const allSameAsOld = [
          product.priceTier2,
          product.priceTier3,
          product.priceTier4,
          product.priceTier5,
        ].every(
          (t) =>
            !t ||
            parseFloat(String(t)).toFixed(2) === oldPrice ||
            parseFloat(String(t)).toFixed(2) === "0.00",
        );
        if (allSameAsOld) {
          updates.priceTier2 = newPriceStr;
          updates.priceTier3 = newPriceStr;
          updates.priceTier4 = newPriceStr;
          updates.priceTier5 = newPriceStr;
        } else {
          // Cascade cap: any tier that's currently MORE expensive than the new T1 gets capped
          for (let m = 2; m <= 5; m++) {
            const key = `priceTier${m}` as keyof ApiProduct;
            const tierVal = product[key];
            const tierPrice = tierVal ? parseFloat(String(tierVal)) : 0;
            if (!tierVal || tierPrice > newPrice) {
              updates[`priceTier${m}`] = newPriceStr;
            }
          }
        }
      }
      await updateProduct.mutateAsync(updates);
      toast({ title: "Price updated", variant: "success" });
    } catch {
      toast({ title: "Failed to update price", variant: "error" });
    }
    setEditingPriceId(null);
  };

  const handleEditPriceCancel = () => {
    setEditingPriceId(null);
    setEditPriceValue("");
  };

  const debouncedSearch = useDebounce(search, 300);

  // USB barcode detection on the main search input — rapid keystrokes + Enter = scan
  React.useEffect(() => {
    const input = searchInputRef.current;
    if (!input) return;
    let lastKeyTime = 0;
    let sequence = "";
    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      if (e.key === "Enter") {
        if (sequence.length >= 6 && now - lastKeyTime < 150) {
          e.preventDefault();
          // Code already in `search` via onChange; just trigger immediately by setting directly
          setSearch(sequence);
          sequence = "";
        }
        return;
      }
      if (e.key.length === 1) {
        if (now - lastKeyTime > 200) sequence = e.key;
        else sequence += e.key;
        lastKeyTime = now;
      }
    };
    input.addEventListener("keydown", handleKeyDown);
    return () => input.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset to page 1 whenever filters change
  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, categoryFilter, stockFilter, sectionFilter, pageSize]);

  const {
    data: result,
    isLoading,
    isError,
  } = useProducts({
    search: debouncedSearch,
    category: categoryFilter || undefined,
    stockStatus: (stockFilter || undefined) as any,
    section: sectionFilter || undefined,
    page,
    limit: pageSize, // 0 = all
    includeVariants: true,
  });

  // Separate unfiltered query just to populate the category dropdown — always fetches all
  const { data: allProductsForCategories } = useProducts({ limit: 0 });

  const productList: ApiProduct[] = result?.data ?? [];
  const meta = result?.meta;
  const totalPages = meta?.totalPages ?? 1;
  const totalItems = meta?.total ?? 0;

  const categories = Array.from(
    new Set(
      (allProductsForCategories?.data ?? productList)
        .map((p: ApiProduct) => p.category)
        .filter(Boolean),
    ),
  ) as string[];

  const existingUnits = Array.from(
    new Set(productList.map((p) => p.unit).filter(Boolean)),
  ) as string[];

  // Items are now fully server-filtered — no client-side filtering needed
  const filtered = productList;

  const filteredIds = filtered.map((p) => p.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set(Array.from(prev).concat(filteredIds));
    });

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    try {
      const res = await bulkDelete.mutateAsync(ids);
      setSelected(new Set());
      toast({
        title: `${res.deleted} product${res.deleted !== 1 ? "s" : ""} deleted`,
        variant: "success",
      });
    } catch {
      toast({ title: "Failed to delete products", variant: "error" });
    }
  };

  const productIdList = (result?.data ?? []).map((p: ApiProduct) => p.id);

  const tableColumns = React.useMemo(
    () =>
      makeTableColumns(
        selected,
        toggleOne,
        filteredIds,
        toggleAll,
        selectMode,
        handleEditPrice,
        editingPriceId,
        editPriceValue,
        setEditPriceValue,
        handleEditPriceSave,
        handleEditPriceCancel,
        quickEditMode,
        handleQuickSave,
        barcodeRefs,
        productIdList,
        categories,
        sectionNameById,
        activeSections,
        hasSections,
        handleSectionSave,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      selected,
      filteredIds.join(","),
      allFilteredSelected,
      selectMode,
      editingPriceId,
      editPriceValue,
      quickEditMode,
      productIdList.join(","),
      categories.join(","),
      sectionNameById,
      activeSections,
      hasSections,
      handleSectionSave,
    ],
  );

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Products"
        subtitle={
          totalItems > 0
            ? `${totalItems} SKU${totalItems !== 1 ? "s" : ""} across ${categories.length} ${categories.length === 1 ? "category" : "categories"}.`
            : "Manage your product catalog"
        }
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={
                selectMode ? <XIcon className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />
              }
              onClick={() => {
                setSelectMode((m) => !m);
                setSelected(new Set());
              }}
            >
              {selectMode ? "Cancel" : "Select"}
            </Button>
            <Button
              variant={quickEditMode ? "primary" : "secondary"}
              leftIcon={<Pencil className="h-4 w-4" />}
              onClick={() => {
                setQuickEditMode((q) => !q);
                setViewMode("table");
              }}
              title="Quickly add SKU, barcode, and category inline. Supports barcode scanners."
            >
              {quickEditMode ? "Exit Quick Edit" : "Quick Edit"}
            </Button>
            <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowCreate(true)}>
              New Product
            </Button>
          </div>
        }
      />

      {/* Quick Edit mode banner */}
      {quickEditMode && (
        <div className="rounded-lg bg-brand-50 border border-brand-200 px-4 py-2.5 text-sm text-brand-700 flex items-center gap-2">
          <Pencil className="h-4 w-4 shrink-0" />
          <span>
            <strong>Quick Edit Mode</strong> — click any SKU/Barcode, Category, or Tier Price cell
            to edit. Press{" "}
            <kbd className="rounded border border-brand-300 bg-white px-1 py-0.5 text-xs font-mono">
              Enter
            </kbd>{" "}
            to save,{" "}
            <kbd className="rounded border border-brand-300 bg-white px-1 py-0.5 text-xs font-mono">
              Esc
            </kbd>{" "}
            to cancel. Tier prices cascade automatically — setting T2 caps T3–T5 to the same or
            lower. Use the 📷 camera button for mobile scanning.
          </span>
        </div>
      )}

      {/* Create product modal — creation, its toast, and list refresh are all
          owned by ProductCreateModal itself now; nothing extra to do here. */}
      {showCreate && (
        <ProductCreateModal
          isOpen
          onClose={() => {
            setShowCreate(false);
            setNewVariantParentId(undefined);
          }}
          onCreated={() => {}}
          units={existingUnits}
          defaultParentId={newVariantParentId}
        />
      )}

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

      {/* Toolbar — Ledger filter bar */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-surface-border bg-white px-4 py-3 shadow-card">
        {/* Select all checkbox — only shown in selection mode */}
        {selectMode && (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    !allFilteredSelected && filteredIds.some((id) => selected.has(id));
              }}
              onChange={toggleAll}
              className="h-4 w-4 cursor-pointer rounded border-navy/30 accent-brand-500"
            />
            <span className="text-sm text-navy/70">Select all</span>
          </label>
        )}

        {/* Stock status filter chips */}
        {[
          { value: "", label: "All" },
          { value: "IN_STOCK", label: "In Stock" },
          { value: "LOW", label: "Low Stock" },
          { value: "OUT_OF_STOCK", label: "Out of Stock" },
        ].map((o) => (
          <button
            key={o.value || "all"}
            onClick={() => setStockFilter(o.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors",
              stockFilter === o.value
                ? "border-navy bg-navy text-white"
                : "border-surface-border bg-white text-navy hover:bg-surface-raised",
            )}
          >
            {o.label}
          </button>
        ))}

        <input
          ref={searchInputRef}
          type="search"
          placeholder="Name, SKU or scan barcode…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto h-8 w-64 rounded-lg border border-surface-border bg-white px-3 text-xs text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="w-40">
          <Select
            options={[
              { value: "", label: "All Categories" },
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          />
        </div>

        {/* Per-page selector */}
        <div className="w-36">
          <Select
            options={[
              { value: "20", label: "20 per page" },
              { value: "50", label: "50 per page" },
              { value: "100", label: "100 per page" },
              { value: "200", label: "200 per page" },
              { value: "0", label: "Show all" },
            ]}
            value={String(pageSize)}
            onChange={(e) => setPageSize(Number(e.target.value))}
          />
        </div>

        {/* View toggle */}
        <div className="flex items-center rounded-lg border border-surface-border bg-white p-1">
          <button
            onClick={() => setViewMode("grid")}
            className={cn(
              "rounded p-1.5 transition-colors",
              viewMode === "grid" ? "bg-navy text-white" : "text-navy/70 hover:text-navy",
            )}
            title="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setViewMode("table")}
            className={cn(
              "rounded p-1.5 transition-colors",
              viewMode === "table" ? "bg-navy text-white" : "text-navy/70 hover:text-navy",
            )}
            title="Table view"
          >
            <LayoutList className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Selection action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selected.size} item{selected.size !== 1 ? "s" : ""} selected
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
              leftIcon={<GitBranch className="h-4 w-4" />}
              onClick={() => setShowGroupAsVariants(true)}
              disabled={selected.size < 1}
            >
              Group as variants of…
            </Button>
            {hasSections && (
              <Button
                variant="secondary"
                leftIcon={<Layers className="h-4 w-4" />}
                onClick={() => setShowAssignToSection(true)}
                disabled={selected.size < 1}
              >
                Assign to section…
              </Button>
            )}
            <Button
              variant="danger"
              leftIcon={<Trash2 className="h-4 w-4" />}
              loading={bulkDelete.isPending}
              onClick={handleBulkDelete}
            >
              Delete {selected.size} item{selected.size !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}

      {/* Group as variants modal */}
      <GroupAsVariantsModal
        isOpen={showGroupAsVariants}
        onClose={() => setShowGroupAsVariants(false)}
        selectedIds={Array.from(selected)}
        onSuccess={(result) => {
          if (result.failed.length === 0) {
            setSelected(new Set());
            setSelectMode(false);
          } else {
            // Keep only the failed ones selected so the operator can retry
            setSelected(new Set(result.failed.map((f) => f.id)));
          }
        }}
      />

      {/* Assign to section modal (bulk) */}
      <AssignToSectionModal
        isOpen={showAssignToSection}
        onClose={() => setShowAssignToSection(false)}
        products={filtered
          .filter((p) => selected.has(p.id))
          .map((p) => ({ id: p.id, trackedCategoryId: p.trackedCategoryId ?? null }))}
        onSuccess={() => {
          setSelected(new Set());
          setShowAssignToSection(false);
        }}
      />

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">Failed to load data. Please try refreshing.</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-surface-border bg-white">
          {search || categoryFilter || stockFilter || sectionFilter ? (
            <EmptyState
              variant="products"
              title="No matching products"
              description="No products match your current search and filters."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setCategoryFilter("");
                    setStockFilter("");
                    setUrlFilter("section", "");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="products"
              title="No products yet"
              description="Add your first product to build your catalog and start taking orders."
              action={
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  New product
                </Button>
              }
            />
          )}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              selected={selected.has(p.id)}
              selectionMode={selectMode}
              onSelect={(e) => {
                e.stopPropagation();
                toggleOne(p.id);
              }}
              onClick={() => router.push(`/products/${p.id}`)}
              onAddVariant={(parentId) => {
                setNewVariantParentId(parentId);
                setShowCreate(true);
              }}
              sectionNameById={sectionNameById}
            />
          ))}
        </div>
      ) : (
        <Table
          data={filtered}
          columns={tableColumns}
          onRowClick={(row) => {
            if (selectMode) toggleOne(row.original.id);
            else router.push(`/products/${row.original.id}`);
          }}
        />
      )}

      {/* Pagination bar */}
      {!isLoading && totalItems > 0 && pageSize !== 0 && totalPages > 1 && (
        <div className="flex items-center justify-between rounded-lg border border-surface-border bg-white px-4 py-3">
          <p className="text-sm text-navy/70">
            Showing{" "}
            <span className="font-medium text-navy">
              {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalItems)}
            </span>{" "}
            of <span className="font-medium text-navy">{totalItems}</span> products
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(1)}
              disabled={page === 1}
              className="rounded px-2 py-1.5 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            >
              «
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded px-2 py-1.5 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            >
              ‹ Prev
            </button>

            {/* Page number buttons */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
              .reduce<(number | "…")[]>((acc, p, idx, arr) => {
                if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push("…");
                acc.push(p);
                return acc;
              }, [])
              .map((item, idx) =>
                item === "…" ? (
                  <span key={`ellipsis-${idx}`} className="px-1 text-xs text-navy/30">
                    …
                  </span>
                ) : (
                  <button
                    key={item}
                    onClick={() => setPage(item as number)}
                    className={cn(
                      "min-w-[30px] rounded px-2 py-1.5 text-xs font-medium transition-colors",
                      page === item
                        ? "bg-brand-500 text-white"
                        : "text-navy/70 hover:bg-surface-raised hover:text-navy",
                    )}
                  >
                    {item}
                  </button>
                ),
              )}

            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded px-2 py-1.5 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            >
              Next ›
            </button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page === totalPages}
              className="rounded px-2 py-1.5 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            >
              »
            </button>
          </div>
        </div>
      )}

      {/* Total count when showing all */}
      {!isLoading && totalItems > 0 && pageSize === 0 && (
        <p className="text-center text-sm text-navy/70">
          Showing all <span className="font-medium text-navy">{totalItems}</span> products
        </p>
      )}

      {/* Floating undo/redo bar */}
      {undoStack.length > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-full bg-navy px-5 py-2.5 shadow-xl text-sm text-white">
          <button
            onClick={handleUndo}
            className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
            title="Undo last change"
          >
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </button>
          <span className="text-white/40 text-xs max-w-[200px] truncate">
            {undoStack[undoStack.length - 1].productName} · {undoStack[undoStack.length - 1].field}
          </span>
          {redoStack.length > 0 && (
            <button
              onClick={handleRedo}
              className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
              title="Redo last undone change"
            >
              Redo <Redo2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => {
              setUndoStack([]);
              setRedoStack([]);
            }}
            className="ml-1 text-white/30 hover:text-white transition-colors"
            title="Clear history"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
