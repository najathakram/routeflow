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
