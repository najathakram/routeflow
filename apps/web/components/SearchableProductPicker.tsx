"use client";

import * as React from "react";
import { ChevronDown, Search, X, Check } from "lucide-react";
import { cn, mergeRefs } from "@routeflow/ui/web";
import { useProducts } from "@/lib/api/products";
import { displayProductName } from "@/lib/product-display";

interface PickerProduct {
  id: string;
  name: string;
  sku?: string;
  isActive?: boolean;
  /** Optional richer fields — populated by /products rows, used by the floating preview. */
  barcode?: string;
  variantName?: string | null;
  parentProductId?: string | null;
  /** `{ name: string }` (not optional-name) so this satisfies displayProductName's DisplayProductLike. */
  parent?: { name: string } | null;
  pricePerUnit?: string | number;
  thumbnailUrl?: string | null;
}

interface SearchableProductPickerProps {
  value: string;
  onChange: (productId: string, product?: PickerProduct) => void;
  /** Static mode source list. Optional so pure-async call sites can omit it. */
  products?: PickerProduct[];
  /** Product IDs to hide (e.g., the products being moved into this picker's parent) */
  excludeIds?: string[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** Optional empty-state hint (e.g., "No standalone products yet — create one first") */
  emptyHint?: string;
  /**
   * Exposes the search <input> so a keyboard-wedge BarcodeScannerButton can
   * listen on it (its wedge mode attaches a keydown listener to this ref).
   */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /**
   * Async mode: instead of filtering the static `products` prop, debounce the
   * typed search and query the server (`GET /products`) for the whole
   * catalog — the `products` prop static list is capped (callers commonly
   * pass a 1000-row page) so a product beyond that cap is otherwise
   * unfindable. The fetch only runs while the dropdown is OPEN — a scan
   * review table can render dozens of these pickers at once, and only the
   * one the operator has open should be hitting the network.
   */
  async?: boolean;
  /**
   * Closed-state label to show for the current selection when it isn't
   * present in the static `products` prop / hasn't been fetched yet (async
   * mode) — e.g. the scanned line's OCR description or matched product name.
   */
  selectedLabel?: string;
  /**
   * Floating side panel showing the full detail (name/SKU/barcode/price/
   * thumbnail) of the highlighted option, positioned next to the popup so
   * long composed names never need truncating. Defaults to on.
   */
  preview?: boolean;
}

/**
 * A real searchable combobox that replaces the native `<select>` for product
 * pickers. Native selects don't support type-to-search reliably across browsers
 * and clip badly inside modals — this gives us:
 *   - search input filters by name AND SKU (case-insensitive) — or, in async
 *     mode, a debounced server-side search across the whole catalog
 *   - keyboard arrow / enter / escape navigation
 *   - click outside to close
 *   - clear button when a product is selected
 *   - a floating preview panel for the highlighted option
 */
export function SearchableProductPicker({
  value,
  onChange,
  products = [],
  excludeIds,
  placeholder = "Search products…",
  className,
  disabled,
  emptyHint,
  inputRef: externalInputRef,
  async: asyncMode,
  selectedLabel,
  preview = true,
}: SearchableProductPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const excludeSet = React.useMemo(() => new Set(excludeIds ?? []), [excludeIds]);

  // Debounce the typed search so async mode doesn't fire a request per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Async mode: search the whole catalog server-side, only while this picker
  // is open (the `enabled` gate matters — a scan table can render ~50 of
  // these, only the OPEN one may fetch).
  const { data: asyncData } = useProducts(
    {
      search: debouncedSearch || undefined,
      isActive: true,
      includeVariants: true,
      limit: 50,
    },
    { enabled: !!asyncMode && open },
  );

  const sourceProducts = React.useMemo<PickerProduct[]>(
    () => (asyncMode ? (asyncData?.data ?? []) : products),
    [asyncMode, asyncData, products],
  );

  const visibleProducts = React.useMemo(() => {
    if (asyncMode) {
      // The server already filtered by (debounced) search — just drop excludes.
      return sourceProducts.filter((p) => !excludeSet.has(p.id)).slice(0, 200);
    }
    const q = search.trim().toLowerCase();
    return sourceProducts
      .filter((p) => !excludeSet.has(p.id))
      .filter((p) => {
        if (!q) return true;
        if (displayProductName(p).toLowerCase().includes(q)) return true;
        if (p.sku && p.sku.toLowerCase().includes(q)) return true;
        return false;
      })
      .slice(0, 200); // safety cap so very large catalogs don't kill the DOM
  }, [asyncMode, sourceProducts, excludeSet, search]);

  const selected = React.useMemo(
    () => sourceProducts.find((p) => p.id === value),
    [sourceProducts, value],
  );

  // Async selections are often NOT in the current (debounced, 50-row) page —
  // fall back to the caller-supplied label instead of blanking the field.
  const hasSelection = asyncMode ? !!value : !!selected;
  const closedLabel = asyncMode
    ? (selectedLabel ?? (selected ? displayProductName(selected) : ""))
    : selected
      ? displayProductName(selected)
      : "";

  // Click outside to close
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Reset highlight when filtered list changes
  React.useEffect(() => {
    setHighlight(0);
  }, [search, open]);

  // Floating preview panel position, recomputed whenever the open/highlighted
  // option changes. `position: fixed` so it escapes the `overflow-y-auto`
  // containers both scan surfaces render pickers inside (which clip absolute
  // descendants).
  const [previewPos, setPreviewPos] = React.useState<{ left: number; top: number } | null>(null);

  React.useEffect(() => {
    if (!open || !preview || !visibleProducts[highlight] || !containerRef.current) {
      setPreviewPos(null);
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    const panelWidth = 280;
    const panelMax = 320;
    let left = rect.right + 8;
    if (left + panelWidth > window.innerWidth - 8) {
      left = rect.left - panelWidth - 8;
    }
    const top = Math.min(rect.top, window.innerHeight - panelMax - 8);
    setPreviewPos({ left, top });
  }, [open, preview, highlight, visibleProducts]);

  const handleSelect = (p: PickerProduct) => {
    onChange(p.id, p);
    setSearch("");
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, visibleProducts.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = visibleProducts[highlight];
      if (pick) handleSelect(pick);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-surface-border bg-white px-2.5 py-1.5 transition-colors focus-within:border-transparent focus-within:ring-2 focus-within:ring-brand-500",
          disabled && "cursor-not-allowed opacity-60",
          open && "ring-2 ring-brand-500",
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-navy/70" />
        <input
          ref={mergeRefs(inputRef, externalInputRef)}
          type="text"
          value={open ? search : closedLabel}
          placeholder={hasSelection ? "" : placeholder}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/30 focus:outline-none disabled:cursor-not-allowed"
        />
        {hasSelection && !open ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            disabled={disabled}
            className="rounded p-0.5 text-navy/30 transition-colors hover:bg-surface-raised hover:text-navy"
            title="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <ChevronDown
            className={cn("h-3.5 w-3.5 text-navy/70 transition-transform", open && "rotate-180")}
          />
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-lg">
          {visibleProducts.length === 0 ? (
            <p className="px-3 py-2 text-xs text-navy/70">
              {search.trim() ? "No matches." : (emptyHint ?? "No products yet.")}
            </p>
          ) : (
            <>
              <p className="border-b border-surface-border px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-navy/70">
                {visibleProducts.length} result{visibleProducts.length === 1 ? "" : "s"}
                {sourceProducts.length > visibleProducts.length + excludeSet.size && (
                  <> of {sourceProducts.length - excludeSet.size}</>
                )}
              </p>
              <ul role="listbox">
                {visibleProducts.map((p, idx) => (
                  <li
                    key={p.id}
                    role="option"
                    aria-selected={p.id === value}
                    onMouseDown={(e) => {
                      // mousedown so it fires before the input loses focus / closes
                      e.preventDefault();
                      handleSelect(p);
                    }}
                    onMouseEnter={() => setHighlight(idx)}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm transition-colors",
                      idx === highlight
                        ? "bg-brand-50 text-brand-700"
                        : "text-navy hover:bg-surface-raised",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 break-words" title={displayProductName(p)}>
                        {displayProductName(p)}
                      </p>
                      {p.sku && <p className="truncate text-[11px] text-navy/70">SKU: {p.sku}</p>}
                    </div>
                    {p.isActive === false && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-navy/70">
                        Inactive
                      </span>
                    )}
                    {p.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {open && preview && previewPos && visibleProducts[highlight] && (
        <ProductPreviewPanel
          product={visibleProducts[highlight]}
          left={previewPos.left}
          top={previewPos.top}
        />
      )}
    </div>
  );
}

/**
 * Fixed-position side card showing the full detail of the highlighted
 * option — full (composed) name with no truncation, SKU, barcode, price,
 * and thumbnail. Every field is optional, so it degrades gracefully to a
 * name-only card for the narrow static-mode `PickerProduct` shapes.
 */
function ProductPreviewPanel({
  product,
  left,
  top,
}: {
  product: PickerProduct;
  left: number;
  top: number;
}) {
  const priceNum =
    product.pricePerUnit !== undefined &&
    product.pricePerUnit !== null &&
    product.pricePerUnit !== ""
      ? Number(product.pricePerUnit)
      : null;

  return (
    <div
      style={{ position: "fixed", left, top, width: 280 }}
      className="z-[300] rounded-lg border border-surface-border bg-white p-3 shadow-lg"
    >
      {product.thumbnailUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.thumbnailUrl} alt="" className="mb-2 h-28 w-full rounded object-cover" />
      )}
      <p className="break-words text-sm font-medium text-navy">{displayProductName(product)}</p>
      {(product.sku || product.barcode) && (
        <div className="mt-1 space-y-0.5">
          {product.sku && <p className="text-[11px] text-navy/70">SKU: {product.sku}</p>}
          {product.barcode && (
            <p className="text-[11px] text-navy/70">Barcode: {product.barcode}</p>
          )}
        </div>
      )}
      {priceNum !== null && !Number.isNaN(priceNum) && (
        <p className="mt-1.5 text-sm font-semibold text-navy">${priceNum.toFixed(2)}</p>
      )}
      {product.isActive === false && (
        <span className="mt-1.5 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-navy/70">
          Inactive
        </span>
      )}
    </div>
  );
}
