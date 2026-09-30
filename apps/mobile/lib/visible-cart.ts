/**
 * Guarantee every cart line a visible row in a catalog-style pick list.
 *
 * The order/invoice builders render the (searched/filtered) catalog with
 * inline steppers; a scanned product that falls outside the current filter
 * would otherwise exist only in the totals + cart sheet — which reads as
 * "the item disappeared". Cart lines missing from the base list are pinned
 * ABOVE it, in cart order, so they stay visible and scroll-to-able.
 */
export function withCartRows<T extends { id: string }>(
  base: T[],
  cartIds: string[],
  lookup: (id: string) => T | undefined,
): T[] {
  const shown = new Set(base.map((p) => p.id));
  const extras: T[] = [];
  for (const id of cartIds) {
    if (shown.has(id)) continue;
    const p = lookup(id);
    if (p) extras.push(p);
  }
  return extras.length ? [...extras, ...base] : base;
}

/** A section label row interleaved into the catalog list. */
export interface CatalogSectionHeader {
  /** Stable key + discriminant for renderItem/keyExtractor. */
  __header: "on-order" | "catalogue";
  label: string;
}

export type CatalogRow<T> = T | CatalogSectionHeader;

export function isCatalogHeader<T>(row: CatalogRow<T>): row is CatalogSectionHeader {
  return typeof row === "object" && row != null && "__header" in row;
}

/**
 * Owner ask (2026-08-12): items already ON the order float to a labeled
 * section at the top of the catalogue, the rest under their own label.
 *
 * Ordering inside the top section is CATALOGUE-RELATIVE (page order, with
 * off-page cart snapshots appended) — deliberately NOT add-order or
 * newest-first, so rows never shuffle among themselves while the operator
 * works; a new add INSERTS at its catalogue position, everything else holds
 * still. No items → the plain list, no labels.
 */
export function partitionCatalog<T extends { id: string }>(
  base: T[],
  cartIds: string[],
  lookup: (id: string) => T | undefined,
): CatalogRow<T>[] {
  if (cartIds.length === 0) return base;
  const inCart = new Set(cartIds);
  const onOrder: T[] = base.filter((p) => inCart.has(p.id));
  const shown = new Set(onOrder.map((p) => p.id));
  for (const id of cartIds) {
    if (shown.has(id)) continue;
    const p = lookup(id);
    if (p) onOrder.push(p);
  }
  if (onOrder.length === 0) return base;
  const rest = base.filter((p) => !inCart.has(p.id));
  return [
    { __header: "on-order", label: `On this order (${onOrder.length})` },
    ...onOrder,
    { __header: "catalogue", label: "Catalogue" },
    ...rest,
  ];
}

/** What the builder should render below the search box. */
export interface VisibleCatalog<T> {
  rows: CatalogRow<T>[];
  /** Show the "Browse catalogue" button — the way INTO the full list. */
  showBrowseButton: boolean;
  /** Category chips belong to browse mode only. */
  showCategoryChips: boolean;
  /** Shown when there is nothing else to show. */
  emptyHint?: string;
}

/**
 * The quiet catalogue (owner ask, 2026-08-17).
 *
 * Scanning an item used to dump the operator back on the FULL product list —
 * `acceptScannedProduct` clears the search box, so the filter that was showing
 * two rows falls away and hundreds return. On a handset mid-round that reads as
 * the app losing the work. So the builder now shows only what the operator is
 * actually working on, and the whole catalogue is one deliberate tap away.
 *
 * Four states:
 *  - searching        → flat results, exactly as before (search IS the filter)
 *  - browsing         → today's sectioned view + category chips (opt-in)
 *  - quiet, with cart → ONLY "On this order", plus the way into browse
 *  - quiet, empty     → a hint telling the operator how to start
 *
 * Deliberately does NOT gate the underlying fetch: the local scan fast-path and
 * the wedge auto-add both match against page-1 rows, so those must stay loaded
 * even while nothing is rendered.
 */
export function visibleCatalogRows<T extends { id: string }>({
  base,
  cartIds,
  lookup,
  browsing,
  searchTerm,
}: {
  base: T[];
  cartIds: string[];
  lookup: (id: string) => T | undefined;
  browsing: boolean;
  searchTerm: string;
}): VisibleCatalog<T> {
  if (searchTerm.trim()) {
    return { rows: base, showBrowseButton: false, showCategoryChips: false };
  }

  if (browsing) {
    return {
      rows: partitionCatalog(base, cartIds, lookup),
      showBrowseButton: false,
      showCategoryChips: true,
    };
  }

  // Quiet: the cart, and nothing else. Reuses partitionCatalog's ordering so a
  // row sits in the same place whether or not browse is open, then drops
  // everything from the "Catalogue" header down.
  const partitioned = partitionCatalog(base, cartIds, lookup);
  const catalogueAt = partitioned.findIndex(
    (r) => isCatalogHeader(r) && r.__header === "catalogue",
  );
  const rows = catalogueAt === -1 ? [] : partitioned.slice(0, catalogueAt);

  return {
    rows,
    showBrowseButton: true,
    showCategoryChips: false,
    emptyHint:
      rows.length === 0 ? "Scan, search, or browse the catalogue to add items." : undefined,
  };
}
