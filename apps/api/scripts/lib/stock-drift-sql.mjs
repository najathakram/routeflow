// B562 (SA-136 §1), row 635 (SA-902 MUST 1): THE drift query. `drift = currentStock − Σ StockMovement.quantity` per
// product, over EVERY movement row (all types: the invariant is about quantity, not cost); a product with no movements
// compares its counter against 0. The standing guard (`stock-ledger-gap.mjs`) and the D1 backfill
// (`b562-d1-ledger-gap-backfill.mjs`) both read it from here, so they can never disagree on what drift is
// (stock-drift-sql.pin.spec.ts). READ ONLY: one SELECT. `$1` = a tenant slug, or NULL for every tenant.
export const DRIFTED_PRODUCTS_SQL = `
  SELECT t.slug                AS "tenantSlug",
         p.id                  AS "productId",
         p."tenantId"          AS "tenantId",
         p.name                AS "name",
         p."currentStock"      AS "counter",
         p."averageCost"       AS "averageCost",
         p."unitsPerBox"       AS "unitsPerBox",
         COALESCE(m.total, 0)  AS "ledger",
         COALESCE(m.cnt, 0)::int AS "movementCount",
         p."currentStock" - COALESCE(m.total, 0) AS "drift",
         m.last                AS "lastMovementAt"
    FROM "Product" p
    LEFT JOIN "Tenant" t ON t.id = p."tenantId"
    LEFT JOIN (
      SELECT "productId", SUM(quantity) AS total, COUNT(*) AS cnt, MAX("effectiveAt") AS last
        FROM "StockMovement"
       GROUP BY "productId"
    ) m ON m."productId" = p.id
   WHERE ($1::text IS NULL OR t.slug = $1)
     AND p."currentStock" - COALESCE(m.total, 0) <> 0
   ORDER BY t.slug NULLS FIRST, abs(p."currentStock" - COALESCE(m.total, 0)) DESC, p.id
`;

// The same Σ for ONE product (`$1` = its id): what an apply re-reads under the product lock before it writes.
export const PRODUCT_LEDGER_SQL = `
  SELECT COALESCE(SUM(quantity), 0) AS total, COUNT(*)::int AS cnt
    FROM "StockMovement"
   WHERE "productId" = $1
`;
