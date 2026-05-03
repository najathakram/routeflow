"use client";

import * as React from "react";
import { ChevronDown, Search, X, Check } from "lucide-react";
import { cn } from "@routeflow/ui/web";

interface PickerProduct {
  id: string;
  name: string;
  sku?: string;
  isActive?: boolean;
}

interface SearchableProductPickerProps {
  value: string;
  onChange: (productId: string) => void;
  products: PickerProduct[];
  /** Product IDs to hide (e.g., the products being moved into this picker's parent) */
  excludeIds?: string[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** Optional empty-state hint (e.g., "No standalone products yet — create one first") */
  emptyHint?: string;
}

/**
 * A real searchable combobox that replaces the native `<select>` for product
 * pickers. Native selects don't support type-to-search reliably across browsers
 * and clip badly inside modals — this gives us:
 *   - search input filters by name AND SKU (case-insensitive)
 *   - keyboard arrow / enter / escape navigation
 *   - click outside to close
 *   - clear button when a product is selected
 */
export function SearchableProductPicker({
  value,
  onChange,
  products,
  excludeIds,
  placeholder = "Search products…",
  className,
  disabled,
  emptyHint,
}: SearchableProductPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const excludeSet = React.useMemo(
    () => new Set(excludeIds ?? []),
    [excludeIds],
  );

  const visibleProducts = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => !excludeSet.has(p.id))
      .filter((p) => {
        if (!q) return true;
        if (p.name.toLowerCase().includes(q)) return true;
        if (p.sku && p.sku.toLowerCase().includes(q)) return true;
        return false;
      })
      .slice(0, 200); // safety cap so very large catalogs don't kill the DOM
  }, [products, excludeSet, search]);

  const selected = React.useMemo(
    () => products.find((p) => p.id === value),
    [products, value],
  );

  // Click outside to close
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
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

  const handleSelect = (id: string) => {
    onChange(id);
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
      if (pick) handleSelect(pick.id);
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
        <Search className="h-3.5 w-3.5 shrink-0 text-navy/40" />
        <input
          ref={inputRef}
          type="text"
          value={open ? search : selected?.name ?? ""}
          placeholder={selected ? "" : placeholder}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className="flex-1 bg-transparent text-sm text-navy placeholder:text-navy/30 focus:outline-none disabled:cursor-not-allowed"
        />
        {selected && !open ? (
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
            className={cn(
              "h-3.5 w-3.5 text-navy/40 transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-lg">
          {visibleProducts.length === 0 ? (
            <p className="px-3 py-2 text-xs text-navy/40">
              {search.trim() ? "No matches." : (emptyHint ?? "No products yet.")}
            </p>
          ) : (
            <>
              <p className="border-b border-surface-border px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-navy/40">
                {visibleProducts.length} result{visibleProducts.length === 1 ? "" : "s"}
                {products.length > visibleProducts.length + excludeSet.size && (
                  <> of {products.length - excludeSet.size}</>
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
                      handleSelect(p.id);
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
                      <p className="truncate" title={p.name}>
                        {p.name}
                      </p>
                      {p.sku && (
                        <p className="truncate text-[11px] text-navy/40">
                          SKU: {p.sku}
                        </p>
                      )}
                    </div>
                    {p.isActive === false && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-navy/50">
                        Inactive
                      </span>
                    )}
                    {p.id === value && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
