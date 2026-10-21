"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Package,
  LayoutGrid,
  LayoutList,
  Plus,
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
import { PageHeader, Table, Button, Select, cn, EmptyState } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { useUrlFilters } from "@/lib/hooks/useUrlFilters";
import { useUrlSearch } from "@/lib/hooks/useUrlSearch";
import { useUrlPage, useResetPageOnChange, useClampPage } from "@/lib/hooks/useUrlPage";
import {
  useProducts,
  useProductCategories,
  useUpdateProduct,
  useBulkDeleteProducts,
} from "@/lib/api/products";
import { applyLadderChange, ladderChangeNote, unitWords, type TierField } from "@routeflow/pricing";
import { productTierLabel } from "@/lib/tier-one-label";
import { useTierLabels, type TierLabelsConfig } from "@/lib/api/tier-labels";
import { unitsLabel } from "@/lib/stock-label";
import { useTrackedCategories, type TrackedCategory } from "@/lib/api/tracked-categories";
import { useHasAddon } from "@/lib/api/tobacco";
import { MSRP_ADDON } from "@/lib/api/addons";
import { objectPositionForUrl } from "@/lib/image-focal";
import { GroupAsVariantsModal } from "@/components/GroupAsVariantsModal";
import { ProductCreateModal } from "@/components/ProductCreateModal";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { AssignToSectionModal } from "@/components/AssignToSectionModal";
import { RegulatedScopeTabs } from "@/components/RegulatedScopeTabs";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { QuickEditCell, type EditRecord } from "./_components/QuickEditCell";
import { quickPackEdit } from "@/lib/quick-edit-pack";
import { SectionEditCell } from "./_components/SectionEditCell";
import {
  PortalBulkButtons,
  PortalLimitButtons,
  PortalHiddenBadge,
  PortalHiddenFilter,
} from "./_components/PortalVisibilityControls";
import { portalBadge, portalVisibleFilterParam } from "@/lib/product-portal-visibility-ui";
import { NewFamilyButton } from "@/components/family/NewFamilyButton";
import { deactivateFailureToast, isReadOnlyRefusal } from "@/lib/product-reactivation-refusal";
import { BulkDeleteSkipReport, type SkippedProduct } from "@/components/BulkDeleteSkipReport";
import { ReadOnlyHint, WriteButton } from "@/lib/read-only-gate";
import { ProductsExportButton } from "./_components/ProductsExportButton";
import { ProductNameLink } from "./_components/ProductNameLink";
import { RestrictMenu } from "@/components/restrictions/RestrictMenu";
import { SelectAllMatching } from "@/components/restrictions/SelectAllMatching";
import { OFF_PAGE_HINT, OFF_PAGE_HINT_ID } from "@/lib/rule-chooser";
import { BulkDeleteButton, useOffPageSelection } from "@/components/restrictions/OffPageSelection";
import {
  STOCK_FILTER_CHIPS,
  ProductStatusBadge,
  getProductStatus,
  stockFilterParams,
  type ProductStockFilter,
} from "./_components/product-status";

// U-3a: this list carries no per-product label yet, so it prints the default words.
const UW = unitWords();

// ─── Types ────────────────────────────────────────────────────────────────────

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
  /** Suggested retail price, per PIECE (even for boxed products). Flag-gated (flag.msrp). */
  msrp?: string | null;
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
  /** Buyer-portal flag (hidden products never reach buyers). */
  portalVisible?: boolean;
  isFeatured?: boolean;
  isNew?: boolean;
  isDeal?: boolean;
  /** Regulated section + subcategory tags (Phase 4 / section isolation). */
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
  /** Per-product report codes — template-scoped, cleared when the section changes. */
  regItemType?: string | null;
  regUomCase?: string | null;
  regUomUnit?: string | null;
}

// Merchandising badge row (P5-01) — reused by grid card + table cell.
function MerchBadges({ product }: { product: ApiProduct }) {
  if (!product.isFeatured && !product.isNew && !product.isDeal && !portalBadge(product))
    return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <PortalHiddenBadge product={product} />
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
  const status = getProductStatus(product);
  const trackedTypeTitle = product.trackedCategoryId
    ? ((product as any).trackedSubcategory?.name ??
      sectionNameById.get(product.trackedCategoryId) ??
      "Type")
    : undefined;
  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border bg-white text-left shadow-card transition-shadow hover:shadow-dropdown cursor-pointer",
        status === "LOW" && "border-warning/40",
        status === "OUT_OF_STOCK" && "border-warning/40",
        (status === "IN_STOCK" || status === "INACTIVE") && "border-surface-border",
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
          status === "OUT_OF_STOCK" && "bg-warning-bg",
          (status === "IN_STOCK" || status === "INACTIVE") && "bg-surface-raised",
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
              status === "OUT_OF_STOCK" && "text-warning/40",
              (status === "IN_STOCK" || status === "INACTIVE") && "text-navy/20",
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
            {selectionMode ? (
              (product.variantName ?? product.name)
            ) : (
              <ProductNameLink id={product.id} stretched srNote={trackedTypeTitle}>
                {product.variantName ?? product.name}
              </ProductNameLink>
            )}
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
          <ProductStatusBadge status={status} currentStock={product.currentStock} />
          <MerchBadges product={product} />
          {product.trackedCategoryId && (
            <span
              title={trackedTypeTitle}
              aria-hidden="true"
              className="relative z-10 rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700"
            >
              {sectionNameById.get(product.trackedCategoryId) ?? "Type"}
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
            className="relative z-10 mt-1 flex items-center gap-1 text-[10px] text-navy/70 hover:text-brand-500 transition-colors"
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
  ) => Promise<void | false>,
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
  hasMsrpAddon: boolean,
  tierLabels: TierLabelsConfig | undefined,
): ColumnDef<ApiProduct, unknown>[] {
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = !allSelected && allIds.some((id) => selected.has(id));

  const sectionCol: ColumnDef<ApiProduct, unknown> = {
    id: "section",
    header: "Type",
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
      const sectionName = sectionNameById.get(p.trackedCategoryId) ?? "Type";
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

  // MSRP column — flag-gated (flag.msrp); the primary bulk-edit surface for it.
  const msrpCol: ColumnDef<ApiProduct, unknown> = {
    id: "msrp",
    header: "MSRP",
    enableSorting: false,
    cell: ({ row }) => {
      const p = row.original;
      if (quickEditMode) {
        return (
          <QuickEditCell
            productId={p.id}
            productName={p.name}
            field="msrp"
            type="number"
            value={p.msrp != null ? parseFloat(String(p.msrp)).toFixed(2) : ""}
            quickEditMode={quickEditMode}
            onSave={(newVal, rec) => onQuickSave(p, "msrp", newVal, rec)}
          />
        );
      }
      return (
        <span className="font-mono tabular-nums text-sm text-navy/70">
          {p.msrp != null && parseFloat(String(p.msrp)) > 0 ? (
            <>
              ${parseFloat(String(p.msrp)).toFixed(2)}
              <span className="ml-0.5 text-[10px] text-navy/40">/{UW.base.short.one}</span>
            </>
          ) : (
            <span className="text-navy/30">—</span>
          )}
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
        const status = getProductStatus(p);
        return (
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-11 w-9 flex-none items-center justify-center overflow-hidden rounded-md border",
                status === "LOW"
                  ? "border-warning/40 bg-warning-bg"
                  : status === "OUT_OF_STOCK"
                    ? "border-warning/40 bg-warning-bg"
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
                {selectMode ? p.name : <ProductNameLink id={p.id}>{p.name}</ProductNameLink>}
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
                {p.unitsPerBox && p.unitsPerBox > 1
                  ? `${UW.pack.lower} + ${UW.base.lower}`
                  : p.unit}
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
      header: `${UW.base.other} per ${UW.pack.lower}`,
      enableSorting: false,
      cell: ({ row }) => {
        const p = row.original;
        if (quickEditMode) {
          return (
            <QuickEditCell
              productId={p.id}
              productName={p.name}
              field="unitsPerBox"
              type="number"
              min={1}
              step={1}
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
      // Compact column header — keep the existing "T2".."T5" abbreviation as the
      // fallback (this column is narrow) and only swap in a configured tier name,
      // rather than tierLabel()'s "Tier N" fallback which would widen it by default.
      header: tierLabels?.[String(tier)]?.trim() || `T${tier}`,
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
    ...(hasMsrpAddon ? [msrpCol] : []),
    {
      accessorKey: "currentStock",
      header: "Stock",
      cell: ({ row }) => {
        const status = getProductStatus(row.original);
        return (
          <div className="flex items-center gap-2">
            <ProductStatusBadge status={status} currentStock={row.original.currentStock} />
            {/* `currentStock` is a PIECE count system-wide, so it must never be printed
                next to `unit` (the box/case noun) — `unitsLabel` keeps that noun only
                for unboxed products and shows a box+piece split otherwise. */}
            <span className="text-xs text-navy/70">
              {unitsLabel(row.original.currentStock, row.original.unitsPerBox, row.original.unit)}
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
  // the target of the /products/create redirect stub). The param is consumed —
  // stripped as soon as it's honored — because this effect re-runs on every
  // searchParams change, and search now writes to the URL: leaving `action` in
  // place would re-open the modal on the next keystroke after the user closed it.
  React.useEffect(() => {
    if (searchParams.get("action") !== "new") return;
    setShowCreate(true);
    const params = new URLSearchParams(window.location.search);
    params.delete("action");
    const qs = params.toString();
    router.replace(qs ? `/products?${qs}` : "/products", { scroll: false });
  }, [searchParams, router]);

  const [search, setSearch, debouncedSearch] = useUrlSearch();
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [stockFilter, setStockFilter] = React.useState<ProductStockFilter>("");
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
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = React.useState(false);
  // What the last bulk delete refused and why (#3323): shown in a dialog, not buried in a toast.
  const [skipReport, setSkipReport] = React.useState<SkippedProduct[]>([]);
  // Names of the products in the last bulk delete, taken before the selection clears, for the skip report.
  const [skipNames, setSkipNames] = React.useState<ReadonlyMap<string, string>>(new Map());
  const [hiddenOnly, setHiddenOnly] = React.useState(false);
  const [page, setPage] = useUrlPage();
  const [pageSize, setPageSize] = React.useState(50);
  const hasMsrpAddon = useHasAddon(MSRP_ADDON);
  const { data: tierLabels } = useTierLabels();
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
      // SA-797a: the size as a number, with the pack the cell read; undo / redo carry their own expected pack.
      if (field === "unitsPerBox") {
        const pack = quickPackEdit(product, newVal);
        if (!pack.ok) {
          // Invalid size: no PATCH, the cell stays open (the `false` result) so the typo can be fixed.
          toast({ title: pack.message, variant: "error" });
          return false;
        }
        await updateProduct.mutateAsync({ id: product.id, ...pack.save });
        toast({ title: `${field} updated`, variant: "success" });
        setUndoStack((prev) => [
          ...prev.slice(-19),
          { ...record, oldValue: pack.undo, newValue: pack.redo },
        ]);
        setRedoStack([]);
        return;
      }
      const updates: { id: string; [k: string]: unknown } = {
        id: product.id,
        [field]: newVal || null,
      };

      // A list change moves tiers 2-5 by the ONE ladder rule (applyLadderChange("pricePerUnit"), SA ruling
      // 2026-10-14): equal to the old list moves, 0 stays 0 (it follows the list), a tier above the new list is capped.
      // The old inline copy here froze 0 tiers at the new price and left equal tiers behind in a mixed ladder.
      let ladderNote: string | null = null;
      if (field === "pricePerUnit" && newVal) {
        const moved = applyLadderChange(
          "pricePerUnit",
          product.pricePerUnit,
          newVal,
          product as never,
        );
        Object.assign(updates, moved);
        ladderNote = ladderChangeNote(moved, (n) => productTierLabel(tierLabels, n));
      }

      // P0 2026-10-14: a tier commit moves lower tiers only by applyLadderChange (tracking the old value, 0, or above
      // the new price), never a blind copy-down. The list price keeps its own behaviour above.
      if (field.startsWith("priceTier") && newVal) {
        const moved = applyLadderChange(
          field as TierField,
          (product as unknown as Record<string, unknown>)[field] as string,
          newVal,
          product as never,
        );
        Object.assign(updates, moved);
        ladderNote = ladderChangeNote(moved, (n) => productTierLabel(tierLabels, n));
      }

      await updateProduct.mutateAsync(updates);
      // A save that moved other tiers names them (SA: never silent).
      toast({
        title: `${field} updated`,
        ...(ladderNote ? { description: ladderNote } : {}),
        variant: "success",
      });

      // Push an OBJECT PATCH covering every field this save touched — not just the field
      // the operator edited — so a cascade (pricePerUnit or priceTierN) can be undone/redone
      // in one shot instead of leaving the cascaded tiers stranded.
      const patchFields = Object.keys(updates).filter((k) => k !== "id");
      const oldValue: Record<string, unknown> = {};
      const newValue: Record<string, unknown> = {};
      const productAsRecord = product as unknown as Record<string, unknown>;
      for (const k of patchFields) {
        oldValue[k] = k === field ? record.oldValue : (productAsRecord[k] ?? null);
        newValue[k] = updates[k];
      }
      setUndoStack((prev) => [...prev.slice(-19), { ...record, oldValue, newValue }]);
      setRedoStack([]);
    },
    [updateProduct, toast, tierLabels],
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
      // The regulatory trio (regItemType/regUomCase/regUomUnit) is vocabulary scoped to the
      // section's report template — the API rejects a type change that would strand stale codes
      // under a template with no per-product config. The create modal and detail form already
      // clear the trio client-side on a section change; this cell must match. A subcategory-only
      // change (same type) leaves the trio alone.
      const typeChanged = (patch.trackedCategoryId ?? null) !== (prior.trackedCategoryId ?? null);
      const fullPatch: Record<string, unknown> = typeChanged
        ? { ...patch, regItemType: null, regUomCase: null, regUomUnit: null }
        : patch;
      const fullPrior: Record<string, unknown> = typeChanged
        ? {
            ...prior,
            regItemType: product.regItemType ?? null,
            regUomCase: product.regUomCase ?? null,
            regUomUnit: product.regUomUnit ?? null,
          }
        : prior;
      try {
        await updateProduct.mutateAsync({ id: product.id, ...fullPatch });
      } catch (err) {
        const msg = (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message;
        toast({
          title: "Failed to update regulated type",
          description: typeof msg === "string" ? msg : undefined,
          variant: "error",
        });
        return;
      }
      toast({ title: "Regulated type updated", variant: "success" });
      setUndoStack((prev) => [
        ...prev.slice(-19),
        {
          productId: product.id,
          productName: product.name,
          field: "section",
          oldValue: fullPrior,
          newValue: fullPatch,
        },
      ]);
      setRedoStack([]);
    },
    [updateProduct, toast],
  );

  // A record's old/new value is either a scalar (a single field's prior/next value — the
  // original quick-edit shape) or an object patch (several fields at once — "section" always
  // did this; a tier-price cascade now does too). Detect by type rather than special-casing
  // `field === "section"`, so both shapes keep working through the same code path.
  const asPatch = (field: string, value: EditRecord["oldValue"]): Record<string, unknown> =>
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : { [field]: value };

  const handleUndo = async () => {
    const record = undoStack[undoStack.length - 1];
    if (!record) return;
    const patch = asPatch(record.field, record.oldValue);
    await updateProduct.mutateAsync({ id: record.productId, ...patch });
    toast({ title: `Undone: ${record.productName} · ${record.field}`, variant: "success" });
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, record]);
  };

  const handleRedo = async () => {
    const record = redoStack[redoStack.length - 1];
    if (!record) return;
    const patch = asPatch(record.field, record.newValue);
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
      const updates: { id: string; [k: string]: unknown } = { id, pricePerUnit: newPriceStr };
      // The ONE list → tiers rule (applyLadderChange("pricePerUnit"), SA ruling 2026-10-14). The old inline copy here
      // left a tier equal to the old list frozen whenever the ladder was mixed (9/10/0/10 → 12 kept the 10s at 10).
      const moved = product
        ? applyLadderChange("pricePerUnit", product.pricePerUnit, newPriceStr, product as never)
        : {};
      Object.assign(updates, moved);
      const ladderNote = ladderChangeNote(moved, (n) => productTierLabel(tierLabels, n));
      await updateProduct.mutateAsync(updates);
      toast({
        title: "Price updated",
        ...(ladderNote ? { description: ladderNote } : {}),
        variant: "success",
      });
    } catch {
      toast({ title: "Failed to update price", variant: "error" });
    }
    setEditingPriceId(null);
  };

  const handleEditPriceCancel = () => {
    setEditingPriceId(null);
    setEditPriceValue("");
  };

  // USB barcode detection on the main search input — rapid keystrokes + Enter = scan.
  // Scan timing is unaffected by search living in the URL: only the debounced value
  // is written, so a burst of scanner keystrokes still triggers no navigation until
  // the burst ends.
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

  // Reset to page 1 whenever a filter CHANGES — but not on mount, or the reset
  // would clobber the ?page= restored when the operator presses Back (page now
  // lives in the URL via useUrlPage).
  useResetPageOnChange(setPage, [
    debouncedSearch,
    categoryFilter,
    stockFilter,
    sectionFilter,
    pageSize,
    hiddenOnly,
  ]);

  // REG-B154: the selection Set used to accumulate across page/search/category/
  // section changes (toggleAll only ever concatenated — see toggleAll below), so
  // a selection made on one page silently carried into another page's bulk
  // actions. Reset it whenever the visible set could have changed underneath it.
  // Deps must mirror the useProducts query keys below (NOT just the inputs
  // useResetPageOnChange watches): on page 1 its setPage(1) is a no-op, so `page`
  // never changes and a stock-filter or page-size switch would otherwise leave a
  // stale selection pointing at rows that are no longer visible.
  React.useEffect(() => {
    setSelected(new Set());
    setShowBulkDeleteConfirm(false);
    setShowAssignToSection(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, categoryFilter, stockFilter, sectionFilter, pageSize, hiddenOnly]);

  // The filters the list shows. "Select all matching" (row 509) fetches ids with THIS object, so the ids can never
  // drift from the rows on screen.
  const listFilters = {
    search: debouncedSearch,
    category: categoryFilter || undefined,
    ...stockFilterParams(stockFilter),
    section: sectionFilter || undefined,
    ...portalVisibleFilterParam(hiddenOnly),
    includeVariants: true,
  };

  const {
    data: result,
    isLoading,
    isError,
  } = useProducts({
    ...listFilters,
    page,
    limit: pageSize, // 0 = all
  });

  // Category dropdown: the tenant's distinct categories from their own endpoint (not the whole catalog).
  const { data: tenantCategories } = useProductCategories();

  const productList: ApiProduct[] = result?.data ?? [];
  const meta = result?.meta;
  const totalPages = meta?.totalPages ?? 1;
  useClampPage(setPage, page, meta?.totalPages);
  const totalItems = meta?.total ?? 0;

  const categories = (tenantCategories ??
    Array.from(
      new Set(productList.map((p: ApiProduct) => p.category).filter(Boolean)),
    )) as string[];

  const existingUnits = Array.from(
    new Set(productList.map((p) => p.unit).filter(Boolean)),
  ) as string[];

  // Items are now fully server-filtered — no client-side filtering needed
  const filtered = productList;

  const filteredIds = filtered.map((p) => p.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  // Lookup for the FULL selection (not just the currently-visible page) — REG-B154:
  // AssignToSectionModal used to receive `filtered.filter(p => selected.has(p.id))`,
  // the intersection of the selection with whatever page happened to be loaded, which
  // silently dropped any id selected on a different page/filter view.
  const productById = React.useMemo(() => new Map(filtered.map((p) => [p.id, p])), [filtered]);

  // Row 509: "Select all matching" puts ids BEYOND this page in the selection. Derived from the ids themselves (not from
  // the banner's state), so deselecting one visible row cannot turn the other actions back on for ids the operator
  // cannot see. Only Restrict… may act on such a selection; every other bulk action is off, with a hint.
  const { offPage: bannerSelected, hint: offPageHint } = useOffPageSelection(selected, (id) =>
    productById.has(id),
  );

  // Names of the selected products this page holds (the rule editor labels its chips from them).
  const selectedNames = React.useMemo(() => {
    const out: Record<string, string> = {};
    selected.forEach((id) => {
      const name = productById.get(id)?.name;
      if (name) out[id] = name;
    });
    return out;
  }, [selected, productById]);

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
    if (bannerSelected) return;
    const ids = Array.from(selected);
    try {
      // R1's server contract is {deleted, softDeleted, skipped[]} (vendor-bills'
      // processed-vs-skipped shape); the hook merges those three across chunks.
      const res = await bulkDelete.mutateAsync(ids);
      setSkipNames(new Map(ids.map((id) => [id, productById.get(id)?.name ?? ""])));
      setSelected(new Set());
      const { softDeleted, skipped } = res;
      const parts = [`${res.deleted} deleted`];
      if (softDeleted > 0) parts.push(`${softDeleted} deactivated (has history)`);
      if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
      toast({
        title: parts.join(", "),
        variant: res.deleted > 0 || softDeleted > 0 ? "success" : "error",
      });
      if (skipped.length > 0) setSkipReport(skipped);
    } catch (err) {
      if (!isReadOnlyRefusal(err)) toast(deactivateFailureToast(err, "Failed to delete products"));
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
        hasMsrpAddon,
        tierLabels,
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
      hasMsrpAddon,
      tierLabels,
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
          <div className="flex flex-wrap items-center justify-end gap-2">
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
            <ProductsExportButton
              total={totalItems}
              loading={isLoading}
              filters={{
                search: debouncedSearch,
                category: categoryFilter,
                ...stockFilterParams(stockFilter),
                ...portalVisibleFilterParam(hiddenOnly),
                section: sectionFilter,
              }}
            />
            <NewFamilyButton />
            <WriteButton
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setShowCreate(true)}
            >
              New Product
            </WriteButton>
          </div>
        }
      />
      <ReadOnlyHint className="px-1 text-xs text-slate-600" />

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
          owned by ProductCreateModal itself. K12 F07: the list then opens the
          product just made (the toast survives the navigation). */}
      {showCreate && (
        <ProductCreateModal
          isOpen
          onClose={() => {
            setShowCreate(false);
            setNewVariantParentId(undefined);
          }}
          onCreated={(created) => router.push(`/products/${created.id}`)}
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
        {STOCK_FILTER_CHIPS.map((o) => (
          <button
            key={o.value || "all"}
            type="button"
            aria-pressed={stockFilter === o.value}
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
          onKeyDown={(e) => {
            // K11-09: ArrowDown reaches the first product link of the current view (grid or table).
            // Not during an IME composition: there ArrowDown picks a candidate.
            if (e.key !== "ArrowDown" || e.nativeEvent.isComposing) return;
            const first = document.querySelector<HTMLAnchorElement>("a[data-product-name-link]");
            if (!first) return;
            e.preventDefault();
            first.focus();
          }}
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

        <PortalHiddenFilter checked={hiddenOnly} onChange={setHiddenOnly} />

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

      {/* Row 509 (owner Q5): "Select all N matching" - only under the toolbar, only in select mode. */}
      {selectMode && (
        <SelectAllMatching
          filters={listFilters}
          resetKey={[
            page,
            debouncedSearch,
            categoryFilter,
            stockFilter,
            sectionFilter,
            pageSize,
            hiddenOnly,
          ].join("|")}
          selected={selected}
          setSelected={setSelected}
          pageIds={filteredIds}
          total={totalItems}
        />
      )}

      {/* Selection action bar */}
      {selectMode && selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
          <span className="text-sm font-medium text-navy">
            {selected.size} item{selected.size !== 1 ? "s" : ""} selected
          </span>
          {bannerSelected && (
            <p id={OFF_PAGE_HINT_ID} className="basis-full text-xs text-navy/70">
              {OFF_PAGE_HINT}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              Deselect all
            </button>
            <Button
              variant="secondary"
              leftIcon={<GitBranch className="h-4 w-4" />}
              onClick={() => setShowGroupAsVariants(true)}
              disabled={selected.size < 1 || bannerSelected}
              title={offPageHint}
              aria-describedby={bannerSelected ? OFF_PAGE_HINT_ID : undefined}
            >
              Group as variants of…
            </Button>
            {hasSections && (
              <Button
                variant="secondary"
                leftIcon={<Layers className="h-4 w-4" />}
                onClick={() => setShowAssignToSection(true)}
                disabled={selected.size < 1 || bannerSelected}
                title={offPageHint}
                aria-describedby={bannerSelected ? OFF_PAGE_HINT_ID : undefined}
              >
                Assign to type…
              </Button>
            )}
            <PortalBulkButtons
              selected={selected}
              onDone={() => setSelected(new Set())}
              offPageHint={offPageHint}
            />
            <PortalLimitButtons
              selected={selected}
              onDone={() => setSelected(new Set())}
              offPageHint={offPageHint}
            />
            <RestrictMenu
              selected={selected}
              names={selectedNames}
              onDone={() => setSelected(new Set())}
            />
            {/* The destructive action sits apart, past a divider, never shoulder to shoulder with Limit in portal. */}
            <div
              data-testid="bulk-destructive"
              className="flex items-center sm:ml-2 sm:border-l sm:border-brand-200 sm:pl-4"
            >
              <BulkDeleteButton
                count={selected.size}
                offPage={bannerSelected}
                hint={offPageHint}
                loading={bulkDelete.isPending}
                onClick={() => setShowBulkDeleteConfirm(true)}
              />
            </div>
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

      {/* Assign to section modal (bulk) — the FULL selection, not the
          intersection with whatever page is currently loaded (see productById
          above). Falls back to trackedCategoryId: null for an id the loaded
          page doesn't carry, which only affects the "None — remove" grouping
          (the assign path only needs the id). */}
      <AssignToSectionModal
        isOpen={showAssignToSection}
        onClose={() => setShowAssignToSection(false)}
        products={Array.from(selected).map((id) => ({
          id,
          trackedCategoryId: productById.get(id)?.trackedCategoryId ?? null,
        }))}
        onSuccess={() => {
          setSelected(new Set());
          setShowAssignToSection(false);
        }}
      />

      <BulkDeleteSkipReport
        skipped={skipReport}
        onClose={() => setSkipReport([])}
        nameById={skipNames}
      />

      {/* Bulk delete confirmation */}
      <ConfirmDialog
        open={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        onConfirm={async () => {
          await handleBulkDelete();
          setShowBulkDeleteConfirm(false);
        }}
        title={`Delete ${selected.size} product${selected.size !== 1 ? "s" : ""}?`}
        description="Products referenced by an order, invoice, or other record are deactivated instead of deleted; products with active order items are skipped entirely. Only reference-free products are removed permanently."
        confirmLabel="Delete"
        variant="danger"
        loading={bulkDelete.isPending}
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
                    setHiddenOnly(false);
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
                <WriteButton size="sm" onClick={() => setShowCreate(true)}>
                  New product
                </WriteButton>
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
