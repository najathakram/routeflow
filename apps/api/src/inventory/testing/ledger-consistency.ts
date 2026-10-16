/**
 * X1 (inventory TEST-PLAN): ledger completeness after any stock write.
 *
 * `expectLedgerConsistent(tenantId, productIds)` is the standing invariant of SA-136 §1 as a DB-spec
 * helper. Every new inventory/orders db spec ends with it. Per product:
 *   1. it has an opening row (at least one StockMovement), and
 *   2. `Product.currentStock` = Σ StockMovement.quantity from that opening row on (the same query
 *      `apps/api/scripts/stock-ledger-gap.mjs` runs, scoped to the given products), and
 *   3. the NEWEST movement's `stockAfter` = `currentStock`. Rows written in one transaction can share
 *      a timestamp, so "newest" is the group sharing the latest (effectiveAt, createdAt); the check
 *      passes when any row of that group carries the counter.
 *
 * It lives under `testing/` (excluded from the Nest build by tsconfig.build.json) and reads through its
 * own small pg pool on DATABASE_URL, so it needs no PrismaService. Call `endLedgerHelperPool()` in
 * `afterAll` when you did not pass your own `db`.
 */
import { Pool } from "pg";
import { requireLocalDatabaseUrl, type PgQueryable } from "../../common/testing/db-spec";

export interface LedgerViolation {
  productId: string;
  problem:
    "NOT_IN_TENANT" | "NO_OPENING_ROW" | "COUNTER_NE_LEDGER" | "NEWEST_STOCKAFTER_NE_COUNTER";
  currentStock?: number;
  ledgerSum?: number;
  newestStockAfter?: Array<number | null>;
}

let sharedPool: Pool | undefined;

function defaultDb(): PgQueryable {
  sharedPool ??= new Pool({ connectionString: requireLocalDatabaseUrl() });
  return sharedPool;
}

/** Closes the pool `expectLedgerConsistent` opened for itself (a no-op when `db` was always passed). */
export async function endLedgerHelperPool(): Promise<void> {
  const p = sharedPool;
  sharedPool = undefined;
  await p?.end();
}

const num = (v: unknown): number => Number(v);

/** The violations (empty = consistent). Exposed so a spec can assert a planted inconsistency by shape. */
export async function ledgerViolations(
  tenantId: string,
  productIds: string[],
  db: PgQueryable = defaultDb(),
): Promise<LedgerViolation[]> {
  const ids = [...new Set(productIds)];
  const { rows } = await db.query(
    `SELECT p.id                       AS "productId",
            p."currentStock"           AS "counter",
            COALESCE(SUM(m.quantity), 0) AS "ledger",
            COUNT(m.id)                AS "movements"
       FROM "Product" p
       LEFT JOIN "StockMovement" m ON m."productId" = p.id
      WHERE p."tenantId" = $1 AND p.id = ANY($2::text[])
      GROUP BY p.id, p."currentStock"`,
    [tenantId, ids],
  );
  const byId = new Map(rows.map((r) => [String(r.productId), r]));
  const out: LedgerViolation[] = [];
  for (const productId of ids) {
    const r = byId.get(productId);
    if (!r) {
      out.push({ productId, problem: "NOT_IN_TENANT" });
      continue;
    }
    const currentStock = num(r.counter);
    const ledgerSum = num(r.ledger);
    if (num(r.movements) === 0) {
      out.push({ productId, problem: "NO_OPENING_ROW", currentStock, ledgerSum });
      continue;
    }
    if (currentStock !== ledgerSum) {
      out.push({ productId, problem: "COUNTER_NE_LEDGER", currentStock, ledgerSum });
    }
    const newest = await db.query(
      `SELECT m."stockAfter" AS "stockAfter"
         FROM "StockMovement" m
        WHERE m."productId" = $1
          AND (m."effectiveAt", m."createdAt") = (
                SELECT "effectiveAt", "createdAt" FROM "StockMovement"
                 WHERE "productId" = $1
                 ORDER BY "effectiveAt" DESC, "createdAt" DESC LIMIT 1)`,
      [productId],
    );
    const after = newest.rows.map((x) => (x.stockAfter == null ? null : num(x.stockAfter)));
    if (!after.some((v) => v === currentStock)) {
      out.push({
        productId,
        problem: "NEWEST_STOCKAFTER_NE_COUNTER",
        currentStock,
        newestStockAfter: after,
      });
    }
  }
  return out;
}

/** X1: fails the calling test unless every product's counter, ledger sum and newest `stockAfter` agree. */
export async function expectLedgerConsistent(
  tenantId: string,
  productIds: string[],
  db?: PgQueryable,
): Promise<void> {
  expect(await ledgerViolations(tenantId, productIds, db)).toEqual([]);
}

/**
 * The opening row a fixture product needs: `qty` pieces in via an ADJUSTMENT (notes OPENING) with
 * `stockAfter` = the counter. Pair it with a product created at `currentStock: qty`.
 */
export async function seedOpeningRow(
  db: PgQueryable,
  tenantId: string,
  productId: string,
  qty: number,
): Promise<void> {
  await db.query(
    `INSERT INTO "StockMovement" (id, "productId", type, quantity, "stockAfter", notes, "tenantId", "effectiveAt", "createdAt")
     VALUES (gen_random_uuid()::text, $1, 'ADJUSTMENT', $2, $2, 'OPENING', $3, now() - interval '1 hour', now() - interval '1 hour')`,
    [productId, qty, tenantId],
  );
}
