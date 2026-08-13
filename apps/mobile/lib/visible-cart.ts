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
