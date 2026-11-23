"use client";

import * as React from "react";
import { ChevronRight, Plus } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { formatMoney } from "@/lib/format";
import { countNoun } from "@/lib/plural";
import { attachParent, isGroupExpanded, pickerProductName } from "@/lib/product-search-groups";

/**
 * B1373: the ONE product type-ahead list. Lifted out of Create Order's inline dropdown so the counter
 * sale lists products exactly the way the regular order does (family header + variant count, expandable
 * variants, the unit word, the price, an "already added" dim, and a last "Create new product" row).
 * The caller owns the search, the expanded family and the keyboard nav (`useListboxNav` over
 * `productSearchNavRows(...).rows`); this renders the options and wires clicks.
 */
export type ProductNavRow =
  { kind: "product"; p: any } | { kind: "variant"; v: any } | { kind: "create" };

export interface ProductSearchNav {
  rows: ProductNavRow[];
  productRowIndex: Map<string, number>;
  variantRowIndex: Map<string, number>;
  /** -1 when the list has no create row. */
  createRowIndex: number;
}

/**
 * One flat, ordered row list for the listbox: each product, its variants while expanded, then the
 * trailing "Create new product" row, so every visible option has an id and an Arrow stop.
 */
export function productSearchNavRows(
  products: readonly any[],
  expandedParentId: string | null,
  autoExpandedIds: ReadonlySet<string>,
  withCreate: boolean,
): ProductSearchNav {
  const rows: ProductNavRow[] = [];
  const productRowIndex = new Map<string, number>();
  const variantRowIndex = new Map<string, number>();
  for (const p of products) {
    productRowIndex.set(p.id, rows.length);
    rows.push({ kind: "product", p });
    // Same expansion rule as the rendered list (B1215: a variant-only hit opens its family by itself).
    if (p.variants?.length > 0 && isGroupExpanded(expandedParentId, autoExpandedIds, p.id)) {
      for (const v of p.variants) {
        variantRowIndex.set(v.id, rows.length);
        // The keyboard pick names the variant under its parent exactly like the click does (attachParent).
        rows.push({ kind: "variant", v: attachParent(v, p) });
      }
    }
  }
  const createRowIndex = withCreate ? rows.length : -1;
  if (withCreate) rows.push({ kind: "create" });
  return { rows, productRowIndex, variantRowIndex, createRowIndex };
}

export interface ProductSearchListProps {
  /** Top-level rows from `groupSearchRows` (already capped by the caller). */
  products: readonly any[];
  index: ProductSearchNav;
  nav: {
    listId: string;
    optionId: (i: number) => string;
    highlight: number;
    setHighlight: (i: number) => void;
  };
  expandedParentId: string | null;
  autoExpandedIds: ReadonlySet<string>;
  /** A product already on a line shows dimmed (choosing it again adds one more). */
  isAdded: (productId: string) => boolean;
  /** A family header was clicked: open it, or close it when it is open. */
  onToggleGroup: (product: any, isExpanded: boolean) => void;
  /** A sellable row was clicked (a variant arrives with its parent attached). */
  onPick: (product: any) => void;
  /** The search answered with nothing: show the empty line. */
  showEmpty: boolean;
  /** The last row; absent = no create row (a clerk who may not create items). */
  create?: { term: string; onCreate: () => void };
  /** Keeps the focus in the search field on a pointer press (the counter's scan box). */
  keepInputFocus?: boolean;
  /** Extra classes for every option (the counter's 44 px touch rows). */
  optionClassName?: string;
  className?: string;
  /** The listbox name (the counter keeps its own, "Matching items"). */
  ariaLabel?: string;
  "data-testid"?: string;
  listRef?: React.Ref<HTMLUListElement>;
}

export function ProductSearchList({
  products,
  index,
  nav,
  expandedParentId,
  autoExpandedIds,
  isAdded,
  onToggleGroup,
  onPick,
  showEmpty,
  create,
  keepInputFocus = false,
  optionClassName,
  className,
  ariaLabel = "Products",
  "data-testid": testId,
  listRef,
}: ProductSearchListProps) {
  // mousedown keeps the focus in the search field (its blur would otherwise refocus and race the click)
  const onMouseDown = keepInputFocus ? (e: React.MouseEvent) => e.preventDefault() : undefined;
  return (
    <ul
      ref={listRef}
      id={nav.listId}
      role="listbox"
      aria-label={ariaLabel}
      className={className}
      data-testid={testId}
    >
      {products.length === 0 && showEmpty && (
        <li role="status" className="px-3 py-2 text-sm text-navy/70">
          No products found.
        </li>
      )}
      {products.map((p: any) => {
        const pi = index.productRowIndex.get(p.id) ?? -1; // the flat nav index, shared with variant rows
        const hasVariants = p.variants?.length > 0;
        const isExpanded = isGroupExpanded(expandedParentId, autoExpandedIds, p.id);
        const alreadyAdded = isAdded(p.id);
        return (
          <React.Fragment key={p.id}>
            <li role="presentation">
              <button
                type="button"
                role="option"
                id={nav.optionId(pi)}
                aria-selected={pi === nav.highlight}
                tabIndex={keepInputFocus ? -1 : undefined}
                onMouseDown={onMouseDown}
                onMouseEnter={() => nav.setHighlight(pi)}
                onClick={() => {
                  // Already-added rows add one more (the same as a repeat scan of the code).
                  if (hasVariants) onToggleGroup(p, isExpanded);
                  else onPick(p);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm text-navy hover:bg-surface-raised",
                  pi === nav.highlight && "bg-surface-raised",
                  alreadyAdded && !hasVariants && "opacity-40",
                  optionClassName,
                )}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {hasVariants && (
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-navy/70 transition-transform",
                        isExpanded && "rotate-90",
                      )}
                    />
                  )}
                  <span className="font-medium truncate">{p.name}</span>
                  {p.sku && <span className="text-xs text-navy/70 shrink-0">{p.sku}</span>}
                  {hasVariants && (
                    <span className="ml-1 text-[10px] text-navy/70 shrink-0">
                      {countNoun(p.variants.length, "variant")}
                    </span>
                  )}
                  {!hasVariants && (
                    <span className="ml-1 text-xs text-navy/70 shrink-0">{p.unit}</span>
                  )}
                </div>
                {!hasVariants && (
                  <span className="text-xs font-medium text-navy/70 shrink-0 ml-2">
                    {formatMoney(p.pricePerUnit)}
                  </span>
                )}
              </button>
            </li>
            {/* Expanded variants */}
            {hasVariants &&
              isExpanded &&
              p.variants.map((v: any) => {
                const vi = index.variantRowIndex.get(v.id) ?? -1;
                const variantAdded = isAdded(v.id);
                return (
                  <li key={v.id} role="presentation" className="bg-surface-raised/50">
                    <button
                      type="button"
                      role="option"
                      id={nav.optionId(vi)}
                      aria-selected={vi === nav.highlight}
                      tabIndex={keepInputFocus ? -1 : undefined}
                      onMouseDown={onMouseDown}
                      onMouseEnter={() => nav.setHighlight(vi)}
                      onClick={() => onPick(attachParent(v, p))}
                      className={cn(
                        "flex w-full items-center justify-between pl-8 pr-3 py-2 text-left text-sm text-navy hover:bg-surface-raised",
                        vi === nav.highlight && "bg-surface-raised",
                        variantAdded && "opacity-40",
                        optionClassName,
                      )}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium truncate">{pickerProductName(v, p)}</span>
                        {v.sku && <span className="text-xs text-navy/70 shrink-0">{v.sku}</span>}
                        <span className="text-xs text-navy/70 shrink-0">{v.unit}</span>
                      </div>
                      <span className="text-xs font-medium text-navy/70 shrink-0 ml-2">
                        {formatMoney(v.pricePerUnit)}
                      </span>
                    </button>
                  </li>
                );
              })}
          </React.Fragment>
        );
      })}
      {create && (
        <li role="presentation" className="border-t border-surface-border">
          <button
            type="button"
            role="option"
            id={nav.optionId(index.createRowIndex)}
            aria-selected={index.createRowIndex === nav.highlight}
            tabIndex={keepInputFocus ? -1 : undefined}
            onMouseDown={onMouseDown}
            onMouseEnter={() => nav.setHighlight(index.createRowIndex)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2.5 text-sm text-brand-500 hover:bg-surface-raised font-medium",
              index.createRowIndex === nav.highlight && "bg-surface-raised",
              optionClassName,
            )}
            onClick={create.onCreate}
          >
            <Plus className="h-3.5 w-3.5" />
            Create new product
            {create.term ? `: "${create.term}"` : ""}
          </button>
        </li>
      )}
    </ul>
  );
}
