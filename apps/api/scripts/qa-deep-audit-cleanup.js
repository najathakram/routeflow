/**
 * Deep Audit 2026-05-02 — Cleanup Script
 * --------------------------------------
 * Deletes ONLY rows tagged "QA-..." that the deep-audit workers created in
 * tenant ux-audit-1777265477001. Pre-existing seeded data is NOT touched.
 *
 * Workers used these prefixes (case-sensitive, anchored to start of name):
 *   QA-OPS1-, QA-OPS2-, QA-BUYER1-, QA-BUYER2-,
 *   QA-DRV1-, QA-DRV2-, QA-XR1-, QA-XR2-
 *
 * Modes:
 *   node apps/api/scripts/qa-deep-audit-cleanup.js            # DRY RUN (default)
 *   node apps/api/scripts/qa-deep-audit-cleanup.js --execute  # actually delete
 */

"use strict";
const { Client } = require("pg");

const DB_URL = "postgresql://routeflow:routeflow_prod_2026@gondola.proxy.rlwy.net:41006/routeflow";
const TENANT_SLUG = "ux-audit-1777265477001";
const QA_PATTERN = "QA-%";

const EXECUTE = process.argv.includes("--execute");

function ok(msg) {
  console.log(`   ✓ ${msg}`);
}
function warn(msg) {
  console.log(`   ⚠  ${msg}`);
}
function step(msg) {
  console.log(`\n${"─".repeat(60)}\n  ${msg}`);
}

async function findIds(pg, sql, params) {
  const r = await pg.query(sql, params);
  return r.rows.map((row) => row.id);
}

async function execDel(pg, table, col, ids, label) {
  if (!ids?.length) {
    ok(`No ${label}`);
    return 0;
  }
  if (!EXECUTE) {
    ok(`[DRY] would delete ${ids.length} ${label}`);
    return ids.length;
  }
  const r = await pg.query(`DELETE FROM "${table}" WHERE "${col}" = ANY($1::text[]) RETURNING id`, [
    ids,
  ]);
  ok(`Deleted ${r.rowCount} ${label}`);
  return r.rowCount;
}

async function softDel(pg, table, col, ids, label) {
  if (!ids?.length) return 0;
  if (!EXECUTE) {
    ok(`[DRY] would soft-delete ${ids.length} ${label}`);
    return ids.length;
  }
  try {
    const r = await pg.query(
      `DELETE FROM "${table}" WHERE "${col}" = ANY($1::text[]) RETURNING id`,
      [ids],
    );
    if (r.rowCount > 0) ok(`Deleted ${r.rowCount} ${label}`);
    return r.rowCount;
  } catch {
    return 0;
  }
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  RouteFlow Deep-Audit 2026-05-02 — QA Cleanup           ║");
  console.log(`║  Mode: ${(EXECUTE ? "EXECUTE (destructive)" : "DRY RUN").padEnd(50)}║`);
  console.log(`║  Tenant: ${TENANT_SLUG.padEnd(48)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  try {
    // Tenant scope
    const t = await pg.query(`SELECT id FROM "Tenant" WHERE slug = $1`, [TENANT_SLUG]);
    if (!t.rows[0]) {
      console.error(`Tenant ${TENANT_SLUG} not found`);
      process.exit(1);
    }
    const tenantId = t.rows[0].id;
    ok(`Tenant ${TENANT_SLUG} → ${tenantId}`);

    // 1. Find QA-tagged customers (by businessName)
    step("1. QA-tagged customers");
    const custIds = await findIds(
      pg,
      `SELECT id FROM "Customer" WHERE "tenantId"=$1 AND "businessName" LIKE $2`,
      [tenantId, QA_PATTERN],
    );
    ok(`Found ${custIds.length} QA customers`);

    // 2. Find QA-tagged routes
    step("2. QA-tagged routes");
    const routeIds = await findIds(
      pg,
      `SELECT id FROM "Route" WHERE "tenantId"=$1 AND name LIKE $2`,
      [tenantId, QA_PATTERN],
    );
    ok(`Found ${routeIds.length} QA routes`);

    // 3. Find QA-tagged products (worker may have created)
    step("3. QA-tagged products");
    const prodIds = await findIds(
      pg,
      `SELECT id FROM "Product" WHERE "tenantId"=$1 AND name LIKE $2`,
      [tenantId, QA_PATTERN],
    );
    ok(`Found ${prodIds.length} QA products`);

    // Get RouteRun IDs for QA routes first (used by orders + run cleanup)
    let runIds = [];
    if (routeIds.length) {
      const r = await pg.query(
        `SELECT id FROM "RouteRun" WHERE "tenantId"=$1 AND "routeId" = ANY($2::text[])`,
        [tenantId, routeIds],
      );
      runIds = r.rows.map((x) => x.id);
    }

    // 4. Find orders linked to QA customers OR QA route runs
    step("4. Orders linked to QA customers/runs");
    let orderIds = [];
    if (custIds.length || runIds.length) {
      const r = await pg.query(
        `SELECT id FROM "Order"
         WHERE "tenantId"=$1
         AND ("customerId" = ANY($2::text[]) OR "routeRunId" = ANY($3::text[]))`,
        [tenantId, custIds, runIds],
      );
      orderIds = r.rows.map((x) => x.id);
    }
    ok(`Found ${orderIds.length} QA-linked orders`);

    // 5. Find invoices linked to QA customers
    step("5. Invoices linked to QA customers");
    let invoiceIds = [];
    if (custIds.length) {
      const r = await pg.query(
        `SELECT id FROM "Invoice"
         WHERE "tenantId"=$1 AND "customerId" = ANY($2::text[])`,
        [tenantId, custIds],
      );
      invoiceIds = r.rows.map((x) => x.id);
    }
    ok(`Found ${invoiceIds.length} QA invoices`);

    // 6. Route runs already collected above
    step("6. Route runs for QA routes");
    ok(`Found ${runIds.length} QA route runs`);

    // 7. Find returns linked to QA orders
    step("7. Returns linked to QA orders");
    let returnIds = [];
    if (orderIds.length) {
      const r = await pg.query(
        `SELECT id FROM "Return" WHERE "tenantId"=$1 AND "orderId" = ANY($2::text[])`,
        [tenantId, orderIds],
      );
      returnIds = r.rows.map((x) => x.id);
    }
    ok(`Found ${returnIds.length} QA returns`);

    if (!EXECUTE) {
      console.log("\n═══ DRY RUN SUMMARY ═══");
      console.log(`  Customers : ${custIds.length}`);
      console.log(`  Routes    : ${routeIds.length}`);
      console.log(`  Products  : ${prodIds.length}`);
      console.log(`  Orders    : ${orderIds.length}`);
      console.log(`  Invoices  : ${invoiceIds.length}`);
      console.log(`  RouteRuns : ${runIds.length}`);
      console.log(`  Returns   : ${returnIds.length}`);
      console.log("\nRe-run with --execute to actually delete.\n");
      return;
    }

    // ── DELETE in FK-safe order ──
    let total = 0;

    // Returns first
    step("DEL: Returns");
    if (returnIds.length) {
      await softDel(pg, "ReturnItem", "returnId", returnIds, "return items");
      total += await execDel(pg, "Return", "id", returnIds, "returns");
    }

    // Invoice payments + credit notes + items + invoices
    step("DEL: Invoices");
    if (invoiceIds.length) {
      await softDel(pg, "InvoicePayment", "invoiceId", invoiceIds, "invoice payments");
      await softDel(pg, "CreditNote", "invoiceId", invoiceIds, "credit notes");
      await execDel(pg, "InvoiceItem", "invoiceId", invoiceIds, "invoice items");
      total += await execDel(pg, "Invoice", "id", invoiceIds, "invoices");
    }

    // Route runs + run stops
    step("DEL: Route runs");
    if (runIds.length) {
      await execDel(pg, "RouteRunStop", "routeRunId", runIds, "run stops");
      total += await execDel(pg, "RouteRun", "id", runIds, "route runs");
    }

    // Routes (stops + customers + route)
    step("DEL: Routes");
    if (routeIds.length) {
      await softDel(pg, "RouteCustomer", "routeId", routeIds, "route customers");
      await execDel(pg, "RouteStop", "routeId", routeIds, "route stops");
      total += await execDel(pg, "Route", "id", routeIds, "routes");
    }

    // Orders + items
    step("DEL: Orders");
    if (orderIds.length) {
      await execDel(pg, "OrderItem", "orderId", orderIds, "order items");
      total += await execDel(pg, "Order", "id", orderIds, "orders");
    }

    // Customers + addresses + customer-link
    step("DEL: Customers");
    if (custIds.length) {
      await softDel(pg, "CustomerLink", "customerId", custIds, "customer links");
      await execDel(pg, "CustomerAddress", "customerId", custIds, "customer addresses");
      total += await execDel(pg, "Customer", "id", custIds, "customers");
    }

    // Products + stock movements
    step("DEL: Products");
    if (prodIds.length) {
      await execDel(pg, "StockMovement", "productId", prodIds, "stock movements");
      await softDel(pg, "StockLot", "productId", prodIds, "stock lots");
      total += await execDel(pg, "Product", "id", prodIds, "products");
    }

    console.log(`\n${"═".repeat(65)}`);
    console.log(`  ✅ Cleanup complete — ${total} primary records deleted`);
    console.log(`${"═".repeat(65)}\n`);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error("\n❌ Cleanup failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
