/**
 * SA-767 L-1: the ONE Product-row lock for every stock / cost writer (#2841, B908).
 *
 * One statement: `SELECT id FROM "Product" WHERE "tenantId" = $1 AND id = ANY($2) ORDER BY rank, id
 * FOR UPDATE`. Postgres locks the rows in the order the sort returns them, so the lock order is
 * decided in SQL and cannot drift with the caller's line order.
 *
 * `rank` is the catalog HOUSE LOCK ORDER (products/product-catalog-sync.ts): catalog writers take
 * the FAMILY parent first, then the recipe product, then components / variants in id order. A stock
 * writer that holds a component and then asks for the family deadlocks (40P01) against a catalog
 * writer, so this ranks `Product.kind`:
 *   0  FAMILY   - a family parent (its variants carry `parentProductId`; kind VARIANT ranks 2)
 *   1  RECIPE   - a recipe product (`recipes.service` sets kind RECIPE when it creates the recipe)
 *   2  rest     - STANDARD, VARIANT; the components and plain products, in id order
 *
 * The global order for a writer is: (advisory locks) -> the domain row (Order / PurchaseOrder /
 * VendorBill / Return) -> Products via this helper -> anything else. Always filtered by tenant; an
 * empty tenant id throws so an unfiltered lock can never run.
 */

/** A Prisma TransactionClient, or the `any` tx the order-stock helpers receive. */
type LockTx = { $executeRaw: (...args: any[]) => unknown };

export async function lockProductsForStock(
  tx: LockTx,
  tenantId: string | null | undefined,
  productIds: Iterable<string>,
): Promise<void> {
  if (!tenantId) throw new Error("lockProductsForStock: tenantId is required");
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return;
  await tx.$executeRaw`
    SELECT id FROM "Product"
    WHERE "tenantId" = ${tenantId} AND id = ANY(${ids}::text[])
    ORDER BY CASE kind WHEN 'FAMILY' THEN 0 WHEN 'RECIPE' THEN 1 ELSE 2 END, id
    FOR UPDATE
  `;
}
