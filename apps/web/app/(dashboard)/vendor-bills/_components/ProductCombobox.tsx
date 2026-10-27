"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { useProducts } from "@/lib/api/products";
import { displayProductName } from "@/lib/product-display";
import { sellableFlat } from "@/lib/product-search-groups";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { apiClient } from "@/lib/api-client";
import { useDismissOnLeave } from "@/lib/use-dismiss-on-leave";
import { useListboxNav } from "@/lib/use-listbox-nav";

export interface ProductOption {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  averageCost?: string;
  barcode?: string;
  kind?: string | null;
  variantName?: string | null;
  parentProductId?: string | null;
  parent?: { name: string } | null;
  variants?: ProductOption[];
}

export interface ProductComboboxValue {
  productId: string;
  description: string;
  unit: string;
  unitCost: string;
}

/**
 * Vendor-bill line product search (W-758). Keyboard: ArrowDown/ArrowUp move the highlight, Enter picks it, Escape closes
 * the popup. All of that is the shared `useListboxNav` (scanner-safe: only an arrow key arms Enter, a mouse hover never
 * does; IME composition and an already-handled Enter are ignored); Tab/blur close is the shared `useDismissOnLeave`.
 *
 * `escapeCloseRef` lets the enclosing Radix dialog give this popup the first Escape: the dialog's `onEscapeKeyDown` calls
 * `escapeCloseRef.current?.()` and, when it ran, prevents the dialog dismiss (same shape as CreateOrderModal).
 */
export function ProductCombobox({
  value,
  onChange,
  onCreateNew,
  escapeCloseRef,
}: {
  value: ProductComboboxValue;
  onChange: (update: Partial<ProductComboboxValue>) => void;
  onCreateNew: (search: string) => void;
  escapeCloseRef?: React.MutableRefObject<(() => boolean) | null>;
}) {
  const [search, setSearch] = React.useState(value.description);
  const [open, setOpen] = React.useState(false);
  const barcodeInputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // includeVariants: a family's own name finds its variants; the family itself is never a line (B1215 C7).
  const { data } = useProducts({
    search: search || undefined,
    limit: 20,
    isActive: true,
    includeVariants: true,
  });
  const products: ProductOption[] = sellableFlat<ProductOption>((data as any)?.data ?? []);

  const handleSelect = (p: ProductOption) => {
    onChange({
      productId: p.id,
      description: displayProductName(p),
      unit: p.unit,
      unitCost: p.averageCost ? String(parseFloat(p.averageCost).toFixed(4)) : "",
    });
    setSearch(displayProductName(p));
    setOpen(false);
  };

  const nav = useListboxNav<ProductOption>({
    items: products,
    open,
    onPick: handleSelect,
    onClose: () => setOpen(false),
    resetKey: search,
    idPrefix: `vb-product-${React.useId()}`,
  });
  const leave = useDismissOnLeave(setOpen);

  // The popup takes the dialog's first Escape (closes itself, never the whole bill form).
  React.useEffect(() => {
    if (!open || !escapeCloseRef) return;
    const close = () => {
      setOpen(false);
      return true;
    };
    escapeCloseRef.current = close;
    return () => {
      if (escapeCloseRef.current === close) escapeCloseRef.current = null;
    };
  }, [open, escapeCloseRef]);

  // keep the keyboard-highlighted row in view
  React.useEffect(() => {
    if (nav.highlight < 0) return;
    document.getElementById(nav.optionId(nav.highlight))?.scrollIntoView?.({ block: "nearest" });
  }, [nav.highlight]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleBarcodeScanned = async (code: string) => {
    // 1. Try barcode endpoint
    try {
      const res = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`);
      if (res.data?.id) {
        handleSelect(res.data as ProductOption);
        return;
      }
    } catch {
      /* not found */
    }
    // 2. Try exact SKU match from current results
    const skuMatch = products.find((p) => p.sku === code);
    if (skuMatch) {
      handleSelect(skuMatch);
      return;
    }
    // 3. Fall back to first search result
    if (products.length === 1) {
      handleSelect(products[0]);
      return;
    }
    // 4. Open dropdown with code pre-filled
    setSearch(code);
    setOpen(true);
  };

  return (
    <div ref={containerRef} className="relative flex gap-1">
      <input
        ref={barcodeInputRef}
        type="text"
        placeholder="Search product or scan barcode…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          if (!value.productId) onChange({ description: e.target.value });
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={leave.inputProps.onBlur}
        onKeyDown={(e) => {
          leave.inputProps.onKeyDown(e); // Tab closes
          nav.onKeyDown(e);
        }}
        {...nav.inputProps}
        className="h-9 w-full rounded border border-surface-border bg-white px-2.5 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      <BarcodeScannerButton
        inputRef={barcodeInputRef}
        onScan={handleBarcodeScanned}
        title="Scan product barcode"
      />
      {open && (
        <div
          {...leave.listProps}
          className="absolute left-0 top-10 z-50 w-full rounded-lg border border-surface-border bg-white shadow-dropdown"
        >
          <ul
            id={nav.listId}
            role="listbox"
            aria-label="Products"
            className={products.length > 0 ? "max-h-48 overflow-y-auto py-1" : "sr-only"}
          >
            {products.map((p, i) => (
              <li key={p.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={nav.optionId(i)}
                  aria-selected={i === nav.highlight}
                  tabIndex={-1}
                  onMouseDown={() => handleSelect(p)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-brand-50 aria-selected:bg-brand-50 flex items-center justify-between gap-2"
                >
                  <span>
                    <span className="font-medium text-navy">{displayProductName(p)}</span>
                    {p.sku && <span className="ml-2 text-xs text-navy/70">{p.sku}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-navy/70">{p.unit}</span>
                </button>
              </li>
            ))}
          </ul>
          {products.length === 0 && (
            <div className="px-3 py-2 text-xs text-navy/70">No products found</div>
          )}
          <div className="border-t border-surface-border px-3 py-2">
            <button
              type="button"
              onMouseDown={() => {
                setOpen(false);
                onCreateNew(search);
              }}
              className="flex w-full items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600"
            >
              <Plus size={14} /> Create &quot;{search || "new product"}&quot;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
