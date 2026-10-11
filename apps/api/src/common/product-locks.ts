/**
 * SA-767 L-1: the ONE Product-row lock for every stock / cost writer (#2841, B908).
 *
 * One statement: `SELECT p.id FROM "Product" p WHERE p."tenantId" = $1 AND p.id = ANY($2)
 * ORDER BY <rank>, p.id FOR UPDATE`. Postgres locks the rows in the order the sort returns them, so the lock order is
 * decided in SQL and cannot drift with the caller's line order.
 *
 * `rank` is the catalog HOUSE LOCK ORDER (products/product-catalog-sync.ts), ranked by ROLE, not by
 * `Product.kind`: catalog writers take the FAMILY row first, then the recipe-product row, then
 * components / variants in id order. A stock writer that holds a component and then asks for the
 * family deadlocks (40P01) against a catalog writer. "Family" is a role: a recipe's
 * `familyProductId` or a variant parent can be a STANDARD-kind product, so the rank is
 * `PRODUCT_LOCK_RANK_SQL` (the one ORDER BY expression of this helper, the stock-side twin of that
 * comment):
 *   0  family role         - kind FAMILY, has a child Product (parentProductId), or is a Recipe's family
 *   1  recipe-product role - kind RECIPE, or is a Recipe's product (the first match wins: both roles = 0)
 *   2  rest                - STANDARD, VARIANT; the components and plain products, in id order
 * Every EXISTS is tenant-filtered and index-backed (Product(parentProductId), Recipe(familyProductId),
 * Recipe(productId, version)). Accepted window: recipes.service flips `kind` and inserts the Recipe
 * inside its create tx, invisible to others; a deadlock there costs availability only (the stock
 * tx retry re-runs it).
 *
 * The global order for a writer is: (advisory locks) -> the domain row (Order / PurchaseOrder /
 * VendorBill / Return) -> Products via this helper -> anything else. Always filtered by tenant; an
 * empty tenant id throws so an unfiltered lock can never run.
 */

import { Prisma } from "@prisma/client";

/** A Prisma TransactionClient, or the `any` tx the order-stock helpers receive. */
type LockTx = { $executeRaw: (...args: any[]) => unknown };

/**
 * The lock rank of a Product row aliased `p` (see the header): 0 family role, 1 recipe-product role,
 * 2 the rest. The ONLY ORDER BY expression of `lockProductsForStock`.
 */
export const PRODUCT_LOCK_RANK_SQL = Prisma.sql`CASE
    WHEN p.kind = 'FAMILY'
      OR EXISTS (
        SELECT 1 FROM "Product" c WHERE c."parentProductId" = p.id AND c."tenantId" = p."tenantId"
      )
      OR EXISTS (
        SELECT 1 FROM "Recipe" rf WHERE rf."familyProductId" = p.id AND rf."tenantId" = p."tenantId"
      )
    THEN 0
    WHEN p.kind = 'RECIPE'
      OR EXISTS (
        SELECT 1 FROM "Recipe" rp WHERE rp."productId" = p.id AND rp."tenantId" = p."tenantId"
      )
    THEN 1
    ELSE 2
  END`;

export async function lockProductsForStock(
  tx: LockTx,
  tenantId: string | null | undefined,
  productIds: Iterable<string>,
): Promise<void> {
  if (!tenantId) throw new Error("lockProductsForStock: tenantId is required");
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return;
  await tx.$executeRaw`
    SELECT p.id FROM "Product" p
    WHERE p."tenantId" = ${tenantId} AND p.id = ANY(${ids}::text[])
    ORDER BY ${PRODUCT_LOCK_RANK_SQL}, p.id
    FOR UPDATE
  `;
}
