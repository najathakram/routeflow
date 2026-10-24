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

/**
 * How long a stock-writer tx waits for ANY lock (this helper's row locks and the later row writes)
 * before Postgres gives up with 55P03. Bounds the wait behind a long holder (a count commit, a
 * stuck session) to 5 s instead of the 120 s of a hung request; `retryStockTx` re-runs the tx and
 * an exhausted retry is the coded 503 LOCK_UNAVAILABLE (SA-767 r-note 2 (c)).
 *
 * It is a DEFAULT: the helper sets it only while the tx's `lock_timeout` is still Postgres's
 * default `'0'` (SA-767 L-2.4), so a caller that set its own - tighter or looser - value before
 * calling keeps it.
 */
export const STOCK_LOCK_TIMEOUT = "5s";

/**
 * The tx budget of a stock-writer transaction (SA-767 R6). Prisma's default interactive-tx timeout is 5 s, the same
 * as `STOCK_LOCK_TIMEOUT`, so a long lock holder would surface as an unmapped P2028 before 55P03 could fire. 15 s
 * lets the 5 s lock timeout fire first (55P03 -> retried -> the coded 503), and P2028 stays the backstop.
 */
export const STOCK_TX_OPTIONS = { timeout: 15_000 } as const;

/**
 * Bounds every lock wait of the tx at STOCK_LOCK_TIMEOUT (SET LOCAL semantics: it ends with the tx). Call it as the
 * FIRST statement of a stock-writer tx whose first lock is NOT the Product rows (a PurchaseOrder / VendorBill row
 * lock comes first in the house order), so that domain-row wait is bounded too. Set only while the tx still has
 * Postgres's default `'0'`, so a caller's own value stays.
 */
export async function setStockLockTimeout(tx: LockTx): Promise<void> {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${STOCK_LOCK_TIMEOUT}, true) WHERE current_setting('lock_timeout') = '0'`;
}

export async function lockProductsForStock(
  tx: LockTx,
  tenantId: string | null | undefined,
  productIds: Iterable<string>,
): Promise<void> {
  if (!tenantId) throw new Error("lockProductsForStock: tenantId is required");
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return;
  // The default, set only where the tx has none yet. `set_config(..., true)` is SET LOCAL: it ends
  // with this tx, so the pooled connection never carries the timeout out. Always the first statement.
  await setStockLockTimeout(tx);
  await tx.$executeRaw`
    SELECT p.id FROM "Product" p
    WHERE p."tenantId" = ${tenantId} AND p.id = ANY(${ids}::text[])
    ORDER BY ${PRODUCT_LOCK_RANK_SQL}, p.id
    FOR UPDATE
  `;
}
