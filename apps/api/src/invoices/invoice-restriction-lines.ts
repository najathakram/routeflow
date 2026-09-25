/**
 * F-05 (#2093): which catalog lines an invoice edit or copy asks the selling-restrictions choke point
 * about. An edit only asks about products the invoice did NOT already carry — saving a note on a DRAFT
 * that holds a since-banned product must not be refused for the line it already had (mirrors the
 * delta-netting the order edit path uses); a copy is a brand-new document, so every catalog line counts.
 */
export function newlyAddedRestrictionLines(
  existingProductIds: ReadonlyArray<string | null>,
  items: ReadonlyArray<{ productId?: string | null }>,
): { productId: string }[] {
  const had = new Set(existingProductIds.filter((p): p is string => !!p));
  const added = new Set<string>();
  for (const it of items) if (it.productId && !had.has(it.productId)) added.add(it.productId);
  return [...added].map((productId) => ({ productId }));
}

export function catalogRestrictionLines(
  items: ReadonlyArray<{ productId?: string | null }>,
): { productId: string }[] {
  return newlyAddedRestrictionLines([], items);
}

/** `update` with an item replace: the catalog lines the edit ADDS to what the invoice already holds. */
export async function addedRestrictionLines(
  db: { invoiceItem: { findMany(args: any): Promise<{ productId: string | null }[]> } },
  invoiceId: string,
  items: ReadonlyArray<{ productId?: string | null }>,
): Promise<{ productId: string }[]> {
  const held = await db.invoiceItem.findMany({ where: { invoiceId }, select: { productId: true } });
  return newlyAddedRestrictionLines(
    held.map((r) => r.productId),
    items,
  );
}
