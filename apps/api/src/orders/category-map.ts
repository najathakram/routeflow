import type { TrackedCategoryRow } from "@routeflow/pricing";

/**
 * trackedCategoryId -> TrackedCategory row, for a set of products (B297) — the ONE shared loader
 * every line-creator that needs to STAMP or COPY the rate-snapshot trio uses, so no call site
 * hand-rolls its own `findMany` + `Map` construction. Accepts a `Map<string, product>` (as
 * `UnitEditContext.products` already is) or any iterable of product-like rows. Empty input, or
 * nothing in it regulated, skips the query entirely — same cost-when-idle shape
 * `prepareUnitEditContext` already keeps for its own product/ladder reads.
 */
export async function loadCategoryMapForProducts(
  tx: {
    trackedCategory: {
      findMany(a: {
        where: { id: { in: string[] } };
      }): Promise<(TrackedCategoryRow & { id: string })[]>;
    };
  },
  products:
    | Map<string, { trackedCategoryId?: string | null }>
    | Iterable<{ trackedCategoryId?: string | null }>,
): Promise<Map<string, TrackedCategoryRow>> {
  const list = products instanceof Map ? [...products.values()] : [...products];
  const ids = [...new Set(list.map((p) => p.trackedCategoryId).filter(Boolean))] as string[];
  if (!ids.length) return new Map();
  const rows = await tx.trackedCategory.findMany({ where: { id: { in: ids } } });
  return new Map(rows.map((c) => [c.id, c]));
}
