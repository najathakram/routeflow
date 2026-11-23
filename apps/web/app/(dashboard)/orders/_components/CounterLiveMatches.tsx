"use client";

import * as React from "react";
import { useProducts } from "@/lib/api/products";
import { parseScanField } from "@/lib/counter-sale";
import { groupSearchRows, isFamilyProduct, isGroupExpanded } from "@/lib/product-search-groups";
import { ProductSearchList, productSearchNavRows } from "@/components/ProductSearchList";
import { useListboxNav } from "@/lib/use-listbox-nav";

/** The same wait Create Order's product search uses before it asks the server. */
export const LIVE_MATCH_DEBOUNCE_MS = 300;
/** B1373: the list starts at the first letter, as Create Order's does (a 1-3 digit entry is still a quantity). */
const MIN_TERM_CHARS = 1;
const MAX_ROWS = 10;

interface Options {
  /** The text in "Scan or search items". */
  text: string;
  /** Off while the cart is locked or a sale is in flight. */
  enabled: boolean;
  /** A row chosen by a click or by Enter on the highlighted row. */
  onPick: (product: any) => void;
  /** W-1042: the typed text, offered as a new item (the list's last row). Absent when the clerk may not create one. */
  onCreate?: (text: string) => void;
  /** The products already on a line: their rows show dimmed, as in Create Order. */
  addedIds?: ReadonlySet<string>;
}

/**
 * W-852 + B1373: the till's live match list, the SAME list Create Order shows (`ProductSearchList`): the debounced
 * `useProducts` server search grouped by `groupSearchRows` (a family is a header that opens its variants, never a line),
 * the unit word and price on every row, an "already added" dim, and a last "Create new product" row. `useListboxNav`
 * highlights nothing until an Arrow key, so Enter with no highlight is still the scan path and a wedge scanner is unchanged,
 * and Enter on a highlighted row does what a click on it does.
 */
export function useCounterLiveMatches({ text, enabled, onPick, onCreate, addedIds }: Options) {
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
  const groups = React.useMemo(() => groupSearchRows<any>(data?.data ?? []), [data]);
  const rows = React.useMemo(
    () => (debounced ? groups.rows.slice(0, MAX_ROWS) : []),
    [groups, debounced],
  );
  // The family the clerk opened or closed by hand ("" = closed it); null = the search's own choice.
  const [expandedParentId, setExpandedParentId] = React.useState<string | null>(null);
  React.useEffect(() => setExpandedParentId(null), [term]);

  const [dismissed, setDismissed] = React.useState("");
  const settled = searchable && debounced === term && !isFetching && data !== undefined;
  const empty = settled && rows.length === 0 && dismissed !== term;
  const open = searchable && (rows.length > 0 || empty) && dismissed !== term;
  const index = productSearchNavRows(rows, expandedParentId, groups.expandedIds, !!onCreate);
  const toggleGroup = (p: any, isExpanded: boolean) => setExpandedParentId(isExpanded ? "" : p.id);
  const create = onCreate ? () => onCreate(term) : undefined;
  // Opening or closing a family changes the row count (which resets the highlight): put it back on the header, as Create Order does.
  const keepHighlightOnRow = React.useRef<number | null>(null);
  const nav = useListboxNav<(typeof index.rows)[number]>({
    items: index.rows,
    open,
    onPick: (row) => {
      if (row.kind === "variant") return onPick(row.v);
      if (row.kind === "create") return create?.();
      if (row.p.variants?.length > 0) {
        keepHighlightOnRow.current = index.productRowIndex.get(row.p.id) ?? null;
        return toggleGroup(row.p, isGroupExpanded(expandedParentId, groups.expandedIds, row.p.id));
      }
      if (!isFamilyProduct(row.p)) onPick(row.p);
    },
    onClose: () => setDismissed(term),
    resetKey: `${term}|${debounced}`,
    idPrefix: "counter-match",
  });
  const setHighlight = nav.setHighlight;
  React.useEffect(() => {
    if (keepHighlightOnRow.current !== null) {
      setHighlight(keepHighlightOnRow.current);
      keepHighlightOnRow.current = null;
    }
  }, [expandedParentId, setHighlight]);
  return {
    rows,
    open,
    empty,
    nav,
    term,
    index,
    expandedParentId,
    autoExpandedIds: groups.expandedIds,
    toggleGroup,
    create,
    addedIds: addedIds ?? new Set<string>(),
  };
}

/** The list under the scan field. Renders nothing while closed. */
export function CounterLiveMatches({
  live,
  onPick,
}: {
  live: ReturnType<typeof useCounterLiveMatches>;
  onPick: (product: any) => void;
}) {
  const listRef = React.useRef<HTMLUListElement>(null);
  // On a phone the fixed payment bar covers the lower third: bring the list to the middle of the visible page.
  React.useEffect(() => {
    if (live.open && window.innerWidth < 768)
      listRef.current?.scrollIntoView?.({ block: "center" });
  }, [live.open]);
  if (!live.open) return null;
  return (
    <ProductSearchList
      listRef={listRef}
      products={live.rows}
      index={live.index}
      nav={live.nav}
      expandedParentId={live.expandedParentId}
      autoExpandedIds={live.autoExpandedIds}
      isAdded={(id) => live.addedIds.has(id)}
      onToggleGroup={live.toggleGroup}
      onPick={onPick}
      showEmpty={live.empty}
      create={live.create ? { term: live.term, onCreate: live.create } : undefined}
      ariaLabel="Matching items"
      keepInputFocus
      optionClassName="min-h-[44px]"
      className="max-h-72 overflow-auto rounded-lg border border-surface-border bg-white shadow-dropdown"
      data-testid="counter-live-matches"
    />
  );
}
