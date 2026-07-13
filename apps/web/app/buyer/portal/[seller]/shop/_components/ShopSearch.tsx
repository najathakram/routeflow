"use client";

import * as React from "react";
import { Search, X, Package } from "lucide-react";
import { useBuyerProducts, type BuyerProduct } from "@/lib/api/buyer";
import { objectPositionForUrl } from "@/lib/image-focal";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function suggestionCaption(p: BuyerProduct): string | null {
  const parts: string[] = [];
  if (p.sku) parts.push(`SKU: ${p.sku}`);
  if (p.barcode) parts.push(p.barcode);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface ShopSearchProps {
  value: string;
  onCommit: (search: string) => void;
  /** Total product count for the placeholder — "Search {total} products - name, SKU, barcode...". */
  total?: number;
}

/** Debounced search box with a name/SKU/barcode suggestion dropdown (server search already covers all three). */
export function ShopSearch({ value, onCommit, total }: ShopSearchProps) {
  const [draft, setDraft] = React.useState(value);
  const [focused, setFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Keep local draft in sync when the committed value changes externally (e.g. cleared elsewhere).
  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  // 300ms debounce before committing (preserves the current live-filter behavior).
  React.useEffect(() => {
    const t = setTimeout(() => onCommit(draft), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const trimmed = draft.trim();
  const suggestGate = trimmed.length >= 2 && focused;
  // Params collapse to a stable, cheap key when the gate is closed so we don't
  // hammer the API on every keystroke below the threshold or while unfocused.
  const { data: suggestResult } = useBuyerProducts({
    search: suggestGate ? trimmed : undefined,
    limit: 6,
  });
  const suggestions = suggestGate ? (suggestResult?.data ?? []).slice(0, 6) : [];
  const showDropdown = suggestGate && !dismissed && suggestions.length > 0;

  const selectSuggestion = (p: BuyerProduct) => {
    setDraft(p.name);
    onCommit(p.name);
    setDismissed(true);
    setFocused(false);
    inputRef.current?.blur();
  };

  const clear = () => {
    setDraft("");
    onCommit("");
    setDismissed(false);
    inputRef.current?.focus();
  };

  return (
    <div className="relative flex-1 min-w-[260px]">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy/70" />
      <input
        ref={inputRef}
        type="search"
        placeholder={`Search ${total ?? ""} products - name, SKU, barcode...`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDismissed(false);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDismissed(true);
            e.currentTarget.blur();
          }
        }}
        className="h-10 w-full rounded-lg border border-surface-border bg-white pl-10 pr-3 text-sm text-navy placeholder:text-navy/70 focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
      />
      {draft && (
        <button
          onClick={clear}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-navy/70 hover:text-navy"
          title="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      {showDropdown && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-surface-border bg-white shadow-dropdown"
        >
          {suggestions.map((p) => {
            const thumb = p.thumbnailUrl ?? p.imageUrls?.[0] ?? null;
            const caption = suggestionCaption(p);
            return (
              <button
                key={p.id}
                onClick={() => selectSuggestion(p)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-raised transition-colors"
              >
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-raised">
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="h-full w-full object-cover"
                      style={{ objectPosition: objectPositionForUrl(thumb) }}
                    />
                  ) : (
                    <Package className="h-4 w-4 text-navy/15" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-navy">{p.name}</p>
                  {caption && <p className="truncate text-[11px] text-navy/70">{caption}</p>}
                </div>
                <p className="flex-shrink-0 text-sm font-semibold text-navy">{fmt(p.buyerPrice)}</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ShopSearch;
