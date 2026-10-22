/**
 * SA-841 (B207): each product's LIVE pack, as a map, for `foldMergeItems`. One batched, tenant-scoped read of the
 * stored + incoming products. Read-only: it writes no line and decides no line's factor on its own; the stored-line
 * merge reads it ONLY for a line with no pack of its own (SA-104a(4)) and as the SA-124e(3) price basis.
 */
export async function loadLiveUnitsPerBoxByProduct(
  db: {
    product: {
      findMany: (args: unknown) => Promise<Array<{ id: string; unitsPerBox: number | null }>>;
    };
  },
  productIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, unitsPerBox: true },
  });
  return new Map(rows.map((product) => [product.id, Number(product.unitsPerBox ?? 0)]));
}
