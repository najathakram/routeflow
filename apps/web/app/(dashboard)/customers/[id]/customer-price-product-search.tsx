"use client";

import * as React from "react";
import { useProducts } from "@/lib/api/products";
import { displayProductName } from "@/lib/product-display";
import { sellableFlat } from "@/lib/product-search-groups";

/** The most rows the dropdown asks the server for (the server filters; nothing is cut client-side). */
export const PRICE_PRODUCT_SEARCH_LIMIT = 20;

/**
 * The "Product" field of the customer special-price dialog. It searches the WHOLE catalog on the
 * server (debounced, only while the dropdown is open) instead of filtering a fixed first page of
 * products, so a product past the first 200 is findable. A FAMILY is never offered: its variants
 * stand in for it, named "<Parent> - <Variant>" (B1215 C7).
 */
export function CustomerPriceProductSearch({
  value,
  onValueChange,
  onPick,
}: {
  /** The text in the field (the typed term, or the chosen product's name). */
  value: string;
  onValueChange: (value: string) => void;
  onPick: (product: any) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 300);
    return () => clearTimeout(t);
  }, [value]);

  const term = debounced.trim();
  const { data } = useProducts(
    {
      search: term || undefined,
      isActive: true,
      limit: PRICE_PRODUCT_SEARCH_LIMIT,
      includeVariants: true,
    },
    { enabled: open && term.length > 0 },
  );
  const options = sellableFlat<any>(data?.data ?? []);

  return (
    <div className="relative">
      <input
        type="text"
        placeholder="Search by name or SKU…"
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      {open && value.length > 0 && options.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
          <ul className="max-h-40 overflow-y-auto">
            {options.map((p: any) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-raised"
                  onClick={() => {
                    onPick(p);
                    setOpen(false);
                  }}
                >
                  <span className="text-sm font-medium text-navy">
                    {displayProductName(p)}
                    {p.unit && (
                      <span className="ml-2 text-xs font-normal text-navy/70">{p.unit}</span>
                    )}
                  </span>
                  {p.sku && <span className="font-mono text-xs text-navy/70">{p.sku}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
