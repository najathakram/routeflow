"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { useProducts } from "@/lib/api/products";
import { parseScanField } from "@/lib/counter-sale";
import { displayProductName } from "@/lib/product-display";
import { sellableFlat } from "@/lib/product-search-groups";
import { useListboxNav } from "@/lib/use-listbox-nav";

/** The same wait Create Order's product search uses before it asks the server. */
export const LIVE_MATCH_DEBOUNCE_MS = 300;
const MIN_TERM_CHARS = 2;
const MAX_ROWS = 10;

interface Options {
  /** The text in "Scan or search items". */
  text: string;
  /** Off while the cart is locked or a sale is in flight. */
  enabled: boolean;
  /** A row chosen by a click or by Enter on the highlighted row. */
  onPick: (product: any) => void;
}

/**
 * W-852: the till's live match list. The same pieces Create Order's product search uses: the debounced `useProducts`
 * server search, `sellableFlat` (a family is never a line, its variants are) and `useListboxNav` (nothing is highlighted
 * until an Arrow key, so Enter with no highlight is still the scan path and a wedge scanner is unchanged, and Enter on a
 * highlighted row adds exactly the row shown highlighted).
 */
export function useCounterLiveMatches({ text, enabled, onPick }: Options) {
  const term = text.trim();
  // A 1-3 digit entry is a quantity for the next item, not a search.
  const searchable =
    enabled && term.length >= MIN_TERM_CHARS && parseScanField(text).kind !== "qty";
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(searchable ? term : ""), LIVE_MATCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [term, searchable]);

  // A code-shaped term goes through the candidate-aware scanCode search, as in Create Order.
  const isCode = /^\d{8,14}$/.test(debounced);
  const { data, isFetching } = useProducts(
    {
      search: isCode ? undefined : debounced || undefined,
      scanCode: isCode ? debounced : undefined,
      isActive: true,
      includeVariants: true,
    },
    { enabled: debounced.length >= MIN_TERM_CHARS },
  );
  const rows = React.useMemo(
    () => (debounced ? sellableFlat<any>(data?.data ?? []).slice(0, MAX_ROWS) : []),
    [data, debounced],
  );

  const [dismissed, setDismissed] = React.useState("");
  const settled = searchable && debounced === term && !isFetching && data !== undefined;
  const empty = settled && rows.length === 0 && dismissed !== term;
  const open = searchable && rows.length > 0 && dismissed !== term;
  const nav = useListboxNav<any>({
    items: rows,
    open,
    onPick,
    onClose: () => setDismissed(term),
    resetKey: `${term}|${debounced}`,
    idPrefix: "counter-match",
  });
  return { rows, open, empty, nav };
}

/** The list under the scan field. Renders nothing while closed. */
export function CounterLiveMatches({
  live,
  onPick,
}: {
  live: ReturnType<typeof useCounterLiveMatches>;
  onPick: (product: any) => void;
}) {
  const { rows, open, empty, nav } = live;
  if (empty) {
    return (
      <p
        role="status"
        className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy/70 shadow-dropdown"
      >
        No items match.
      </p>
    );
  }
  if (!open) return null;
  return (
    <ul
      id={nav.listId}
      role="listbox"
      aria-label="Matching items"
      className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-surface-border bg-white shadow-dropdown"
      data-testid="counter-live-matches"
    >
      {rows.map((p, i) => (
        <li key={p.id} role="presentation">
          <button
            type="button"
            role="option"
            id={nav.optionId(i)}
            aria-selected={i === nav.highlight}
            tabIndex={-1}
            // mousedown keeps the focus in the scan field (its blur would otherwise refocus and race the click)
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => nav.setHighlight(i)}
            onClick={() => onPick(p)}
            className={cn(
              "flex min-h-[44px] w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-navy hover:bg-surface-raised",
              i === nav.highlight && "bg-surface-raised",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{displayProductName(p)}</span>
              {p.sku ? <span className="block truncate text-xs text-navy/70">{p.sku}</span> : null}
            </span>
            <span className="shrink-0 text-xs font-medium text-navy/70">
              ${Number(p.pricePerUnit ?? 0).toFixed(2)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
