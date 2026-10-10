#!/usr/bin/env node
/**
 * stock-ledger-gap.mjs — B562 PR-2 (SA-136 §6.3): the standing guard for the stock-ledger invariant.
 *
 * SA-136 §1: every write to `Product.currentStock` appends one StockMovement with the signed quantity
 * that moved it, so the counter equals Σ StockMovement.quantity for every product at every commit.
 * This report reads, per tenant and product, `drift = currentStock − Σ quantity` and lists every
 * product whose drift is not zero. It is to the stock ledger what `schema-drift.mjs` is to the schema.
 *
 * READ ONLY — one SELECT, no write branch, no flags that write. Exit codes:
 *   0  no drift (every product's counter equals its ledger)
 *   2  drift found (listed on stdout)
 *   1  could not run (no database target, query failure)
 *
 * Before B562 PR-2 deployed, order create/edit/cancel moved the counter with no movement row, so a
 * product with order history carries drift until the owner runs the D1 cutover backfill (SA-136 §5,
 * PR-4). From that backfill on, any NEW drift means a writer bypassed the ledger.
 *
 * Run locally (DATABASE_URL from your env / docker-compose):
 *   node apps/api/scripts/stock-ledger-gap.mjs
 * Run against prod (owner / lead-authorised, read-only):
 *   railway run --service postgres node apps/api/scripts/stock-ledger-gap.mjs
 *
 * Options:
 *   --tenant <slug>   one tenant only (also REPORT_TENANT_SLUG). Default: every tenant.
 *   --json            machine-readable rows on stdout.
 *   --limit <n>       rows printed in the text report (default 50; the count is always exact).
 *
 * Tenants are addressed only by the runtime option — this file names none.
 */
import pg from "pg";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const tenantSlug = opt("--tenant") ?? process.env.REPORT_TENANT_SLUG ?? null;
const asJson = argv.includes("--json");
const limit = Number(opt("--limit") ?? 50);

// Σ is taken per product over EVERY movement row (all types): the invariant is about quantity,
// not cost. A product with no movements at all compares its counter against 0.
const SQL = `
  SELECT t.slug              AS "tenantSlug",
         p.id                AS "productId",
         p.name              AS "name",
         p."currentStock"    AS "counter",
         COALESCE(m.total, 0) AS "ledger",
         p."currentStock" - COALESCE(m.total, 0) AS "drift",
         m.last              AS "lastMovementAt"
    FROM "Product" p
    LEFT JOIN "Tenant" t ON t.id = p."tenantId"
    LEFT JOIN (
      SELECT "productId", SUM(quantity) AS total, MAX("effectiveAt") AS last
        FROM "StockMovement"
       GROUP BY "productId"
    ) m ON m."productId" = p.id
   WHERE ($1::text IS NULL OR t.slug = $1)
     AND p."currentStock" - COALESCE(m.total, 0) <> 0
   ORDER BY t.slug NULLS FIRST, abs(p."currentStock" - COALESCE(m.total, 0)) DESC, p.id
`;

async function main() {
  const url = resolveReportDbUrl("stock-ledger-gap");
  if (!url) return 1;
  const pool = new pg.Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(SQL, [tenantSlug]);
    if (asJson) {
      console.log(JSON.stringify({ tenant: tenantSlug, drifted: rows.length, rows }, null, 2));
    } else if (rows.length === 0) {
      console.log(
        `stock-ledger-gap: NO DRIFT — every product's currentStock equals Σ StockMovement.quantity` +
          (tenantSlug ? ` (tenant ${tenantSlug})` : ""),
      );
    } else {
      console.log(
        `stock-ledger-gap: DRIFT on ${rows.length} product(s)` +
          (tenantSlug ? ` (tenant ${tenantSlug})` : "") +
          " — drift = currentStock − Σ quantity",
      );
      for (const r of rows.slice(0, limit)) {
        console.log(
          `  ${r.tenantSlug ?? "<no tenant>"}  ${r.productId}  counter=${r.counter}  ledger=${r.ledger}  drift=${r.drift}  last=${r.lastMovementAt?.toISOString?.() ?? "-"}  ${r.name}`,
        );
      }
      if (rows.length > limit) console.log(`  … ${rows.length - limit} more (--limit to widen)`);
    }
    return rows.length === 0 ? 0 : 2;
  } catch (e) {
    console.error(`stock-ledger-gap: query failed — ${e.message}`);
    return 1;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`stock-ledger-gap: ${e.message}`);
    process.exit(1);
  },
);
