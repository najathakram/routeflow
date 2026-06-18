/**
 * UX Audit Cleanup Script
 * -----------------------
 * Reads a ux-audit-manifest-<ts>.json produced by ux-audit-seed.js and
 * deletes ONLY those records in FK-safe order using direct SQL.
 *
 * Run from repo root:
 *   node apps/api/scripts/ux-audit-cleanup.js apps/api/scripts/ux-audit-manifest-<ts>.json
 *
 * Safety:
 *   - Deletes only IDs recorded in the manifest
 *   - Never truncates or wipes pre-existing data
 *   - Interactive confirmation before proceeding
 */

"use strict";
const { Client } = require("pg");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

// ── Config ────────────────────────────────────────────────────────────────────

const DB_URL = "postgresql://routeflow:routeflow_prod_2026@gondola.proxy.rlwy.net:41006/routeflow";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(msg) {
  console.log(`   ✓ ${msg}`);
}
function warn(msg) {
  console.log(`   ⚠  ${msg}`);
}
function step(msg) {
  console.log(`\n${"─".repeat(60)}\n  ${msg}`);
}

async function confirm(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${msg} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

async function del(pg, table, col, uuids, label) {
  if (!uuids?.length) {
    ok(`No ${label} to delete`);
    return 0;
  }
  const r = await pg.query(`DELETE FROM "${table}" WHERE "${col}" = ANY($1::text[]) RETURNING id`, [
    uuids,
  ]);
  ok(`Deleted ${r.rowCount} ${label}`);
  return r.rowCount;
}

async function softDel(pg, table, col, uuids, label) {
  if (!uuids?.length) return 0;
  try {
    const r = await pg.query(
      `DELETE FROM "${table}" WHERE "${col}" = ANY($1::text[]) RETURNING id`,
      [uuids],
    );
    if (r.rowCount > 0) ok(`Deleted ${r.rowCount} ${label}`);
    return r.rowCount;
  } catch {
    return 0;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const manifestArg = process.argv[2];
  if (!manifestArg) {
    console.error(
      "\n❌ Usage: node apps/api/scripts/ux-audit-cleanup.js <ux-audit-manifest-*.json>\n",
    );
    process.exit(1);
  }

  const absPath = path.resolve(manifestArg);
  if (!fs.existsSync(absPath)) {
    console.error(`\n❌ Manifest not found: ${absPath}\n`);
    process.exit(1);
  }

  const m = JSON.parse(fs.readFileSync(absPath, "utf8"));

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  RouteFlow UX Audit — Cleanup Script                    ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Manifest:    ${path.basename(absPath).padEnd(42)}║`);
  console.log(`║  Created at:  ${(m.createdAt ?? "unknown").slice(0, 42).padEnd(42)}║`);
  console.log(`║  Tenant slug: ${(m.tenantSlug ?? "unknown").padEnd(42)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  const yes = await confirm(
    "⚠  This will permanently delete all records listed in the manifest.\n" +
      "   Only ux-audit data is affected. Pre-existing data is untouched.\n" +
      "   Proceed?",
  );
  if (!yes) {
    console.log("\nAborted.");
    process.exit(0);
  }

  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  console.log("\n✔ Connected to Railway DB");

  let total = 0;

  try {
    // ── helpers to extract UUIDs from manifest arrays ────────────────────────
    const returnIds = (m.returns ?? [])
      .map((x) => (typeof x === "string" ? x : (x.returnId ?? x.id)))
      .filter(Boolean);
    const invoiceIds = (m.invoices ?? [])
      .map((x) => (typeof x === "string" ? x : x.id))
      .filter(Boolean);
    const tmplIds = (m.templates ?? [])
      .map((x) => (typeof x === "string" ? x : x.id))
      .filter(Boolean);
    const runIds = (m.routeRuns ?? [])
      .map((x) => (typeof x === "string" ? x : x.id))
      .filter(Boolean);
    const routeIds = (m.routes ?? [])
      .map((x) => (typeof x === "string" ? x : x.id))
      .filter(Boolean);
    const orderIds = (m.orders ?? [])
      .map((x) => (typeof x === "string" ? x : x.id))
      .filter(Boolean);
    const buyerIds = (m.buyerUsers ?? []).map((b) => b.buyerUserId).filter(Boolean);
    const custIds = (m.customers ?? []).map((c) => c.customerId).filter(Boolean);
    const custUids = (m.customers ?? []).map((c) => c.userId).filter(Boolean);
    const driverIds = (m.drivers ?? []).map((d) => d.driverId).filter(Boolean);
    const driverUids = (m.drivers ?? []).map((d) => d.userId).filter(Boolean);
    const prodIds = (m.products ?? [])
      .map((x) => (typeof x === "string" ? x : x.id))
      .filter(Boolean);
    const suppIds = (m.suppliers ?? [])
      .map((x) => (typeof x === "string" ? x : x.id))
      .filter(Boolean);
    const opUids = [m.adminUserId, m.ownerUserId].filter(Boolean);

    // 1. Returns
    step("1. Returns");
    if (returnIds.length) {
      await softDel(pg, "ReturnItem", "returnId", returnIds, "return items");
      total += await del(pg, "Return", "id", returnIds, "returns");
    } else {
      ok("No returns");
    }

    // 2. Invoice payments
    step("2. Invoice payments");
    total += await del(pg, "InvoicePayment", "invoiceId", invoiceIds, "invoice payments");

    // 3. Credit notes
    step("3. Credit notes");
    total += await del(pg, "CreditNote", "invoiceId", invoiceIds, "credit notes");

    // 4. Invoice items + invoices
    step("4. Invoices");
    if (invoiceIds.length) {
      await del(pg, "InvoiceItem", "invoiceId", invoiceIds, "invoice items");
      total += await del(pg, "Invoice", "id", invoiceIds, "invoices");
    } else {
      ok("No invoices");
    }

    // 5. Order template items + templates
    step("5. Standing order templates");
    if (tmplIds.length) {
      await del(pg, "OrderTemplateItem", "templateId", tmplIds, "template items");
      total += await del(pg, "OrderTemplate", "id", tmplIds, "templates");
    } else {
      ok("No templates");
    }

    // 6. Route run stops + route runs
    step("6. Route runs");
    if (runIds.length) {
      total += await del(pg, "RouteRunStop", "runId", runIds, "run stops");
      total += await del(pg, "RouteRun", "id", runIds, "route runs");
    } else {
      ok("No route runs");
    }

    // 7. Route stops + route customers + routes
    step("7. Routes");
    if (routeIds.length) {
      await del(pg, "RouteCustomer", "routeId", routeIds, "route customers");
      await del(pg, "RouteStop", "routeId", routeIds, "route stops");
      total += await del(pg, "Route", "id", routeIds, "routes");
    } else {
      ok("No routes");
    }

    // 8. Order items + orders
    step("8. Orders");
    if (orderIds.length) {
      await del(pg, "OrderItem", "orderId", orderIds, "order items");
      total += await del(pg, "Order", "id", orderIds, "orders");
    } else {
      ok("No orders");
    }

    // 9. Buyer portal: CustomerLink + BuyerRefreshToken + BuyerAccount
    step("9. Buyer portal accounts");
    if (buyerIds.length) {
      await softDel(pg, "CustomerLink", "buyerAccountId", buyerIds, "customer links (accepted)");
      await softDel(pg, "BuyerRefreshToken", "buyerAccountId", buyerIds, "buyer refresh tokens");
      total += await del(pg, "BuyerAccount", "id", buyerIds, "buyer accounts");
    } else {
      ok("No buyer accounts");
    }
    // Also clear any pending (unaccepted) invites for our customers
    if (custIds.length) {
      await softDel(pg, "CustomerLink", "customerId", custIds, "pending customer links");
    }

    // 10. Customer addresses + customers + customer user accounts
    step("10. Customers");
    if (custIds.length) {
      await del(pg, "CustomerAddress", "customerId", custIds, "customer addresses");
      await del(pg, "Customer", "id", custIds, "customers");
    }
    if (custUids.length) {
      total += await del(pg, "User", "id", custUids, "customer user accounts");
    }

    // 11. LocationPings + drivers + driver user accounts
    step("11. Drivers");
    if (driverIds.length) {
      await softDel(pg, "LocationPing", "driverId", driverIds, "location pings");
      await del(pg, "Driver", "id", driverIds, "drivers");
    }
    if (driverUids.length) {
      total += await del(pg, "User", "id", driverUids, "driver user accounts");
    }

    // 12. Stock movements + products
    step("12. Products + stock");
    if (prodIds.length) {
      await del(pg, "StockMovement", "productId", prodIds, "stock movements");
      await softDel(pg, "StockLot", "productId", prodIds, "stock lots");
      total += await del(pg, "Product", "id", prodIds, "products");
    } else {
      ok("No products");
    }

    // 13. Suppliers
    step("13. Suppliers");
    total += await del(pg, "Supplier", "id", suppIds, "suppliers");

    // 14. Operator user accounts (admin + owner)
    step("14. Operator user accounts");
    if (opUids.length) {
      await softDel(pg, "RefreshToken", "userId", opUids, "refresh tokens");
      await softDel(pg, "UserPreference", "userId", opUids, "user preferences");
      total += await del(pg, "User", "id", opUids, "operator users");
    } else {
      ok("No operator accounts");
    }

    // 15. Tenant + config tables
    step("15. Tenant");
    if (m.tenantId) {
      await pg
        .query(`DELETE FROM "TenantAddon"       WHERE "tenantId" = $1`, [m.tenantId])
        .catch(() => {});
      await pg
        .query(`DELETE FROM "TenantSubscription" WHERE "tenantId" = $1`, [m.tenantId])
        .catch(() => {});
      await pg
        .query(`DELETE FROM "TenantGoogleOAuth"  WHERE "tenantId" = $1`, [m.tenantId])
        .catch(() => {});
      await pg
        .query(`DELETE FROM "TenantConfig"       WHERE "tenantId" = $1`, [m.tenantId])
        .catch(() => {});
      await pg
        .query(`DELETE FROM "AuditLog"           WHERE "tenantId" = $1`, [m.tenantId])
        .catch(() => {});
      const t = await pg.query(`DELETE FROM "Tenant" WHERE id = $1 RETURNING id`, [m.tenantId]);
      total += t.rowCount;
      ok(`Deleted tenant ${m.tenantSlug} (${t.rowCount} row)`);
    } else {
      ok("No tenant ID");
    }

    // 16. SUPER_ADMIN user
    step("16. SUPER_ADMIN user");
    if (m.saUserId) {
      await pg
        .query(`DELETE FROM "RefreshToken" WHERE "userId" = $1`, [m.saUserId])
        .catch(() => {});
      const u = await pg.query(`DELETE FROM "User" WHERE id = $1 RETURNING id`, [m.saUserId]);
      total += u.rowCount;
      ok(`Deleted SUPER_ADMIN user (${u.rowCount} row)`);
    } else {
      ok("No SA user ID");
    }

    // ── Verification ──────────────────────────────────────────────────────────
    step("Verification");
    const tr = await pg.query(`SELECT COUNT(*) FROM "Tenant" WHERE slug = $1`, [m.tenantSlug]);
    const tCount = parseInt(tr.rows[0].count, 10);
    if (tCount === 0) {
      ok(`Tenant "${m.tenantSlug}" fully removed`);
    } else {
      warn(
        `${tCount} Tenant row(s) with slug "${m.tenantSlug}" still exist — manual cleanup needed`,
      );
    }

    if (m.saUserId) {
      const sr = await pg.query(`SELECT COUNT(*) FROM "User" WHERE id = $1`, [m.saUserId]);
      parseInt(sr.rows[0].count, 10) === 0
        ? ok("SUPER_ADMIN user fully removed")
        : warn("SUPER_ADMIN user still present — manual cleanup needed");
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
