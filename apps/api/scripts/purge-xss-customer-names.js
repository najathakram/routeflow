/**
 * purge-xss-customer-names.js
 * ────────────────────────────
 * Deletes Customer rows in the ux-audit tenant whose businessName contains
 * XSS/HTML audit pollution (e.g. `<img src=x onerror=alert("XSS-W18")>`,
 * `XSS Test`, `test`).
 *
 * Safety criteria — a row is deleted only when ALL of the following are true:
 *   1. It belongs to tenant id  8ee7bbf5-991b-41b1-adcb-4a6c20981401  (hard-coded).
 *   2. Its businessName matches the pattern /<\w+|XSS/i  (HTML tag or "XSS" literal).
 *   3. It has zero associated Orders (orderId FK count = 0).
 *   4. It has zero associated Invoices (customerId FK count = 0).
 *
 * Idempotent — re-running after the rows are gone is safe (prints "nothing to do").
 * DO NOT run against the "affa" tenant or any tenant that has real customer data.
 *
 * Run from repo root:
 *   node apps/api/scripts/purge-xss-customer-names.js
 */

"use strict";

const { Client } = require("pg");
const path = require("path");
const fs = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────

/** Hard-coded target — only this tenant is touched. */
const TARGET_TENANT_ID = "8ee7bbf5-991b-41b1-adcb-4a6c20981401";

/** Safety guard — we refuse to run if the resolved tenant happens to be "affa". */
const PROTECTED_SLUG = "affa";

function resolveDatabaseUrl() {
  const envPath = path.join(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf8");
    const match = raw.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
    if (match) return match[1];
  }
  return "postgresql://routeflow:routeflow_prod_2026@gondola.proxy.rlwy.net:41006/routeflow";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dbUrl = resolveDatabaseUrl();
  console.log("[purge-xss-names] Connecting to DB…");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // 1. Verify the target tenant exists.
  const tenantRes = await client.query('SELECT id, slug FROM "Tenant" WHERE id = $1 LIMIT 1', [
    TARGET_TENANT_ID,
  ]);
  if (tenantRes.rows.length === 0) {
    console.log(`[purge-xss-names] Tenant id=${TARGET_TENANT_ID} not found — nothing to do.`);
    await client.end();
    return;
  }
  const tenantSlug = tenantRes.rows[0].slug;
  console.log(`[purge-xss-names] Target tenant: ${tenantSlug} (id=${TARGET_TENANT_ID})`);

  // 2. Safety: refuse to run if this is the "affa" production tenant.
  if (tenantSlug === PROTECTED_SLUG) {
    console.error(`[purge-xss-names] ABORT: tenant slug is "${PROTECTED_SLUG}" — refusing to run.`);
    await client.end();
    process.exit(1);
  }

  // 3. Find candidate Customer rows:
  //    • businessName matches /<\w+|XSS/i  (HTML tag opener OR the literal "XSS")
  //    • zero Orders
  //    • zero Invoices
  //
  // We LEFT JOIN with counts rather than subqueries so one query shows us the
  // candidates without double-counting.
  const candidateRes = await client.query(
    `SELECT c.id, c."businessName",
            COUNT(DISTINCT o.id)::int  AS order_count,
            COUNT(DISTINCT inv.id)::int AS invoice_count
     FROM "Customer" c
     LEFT JOIN "Order"   o   ON o."customerId"  = c.id
     LEFT JOIN "Invoice" inv ON inv."customerId" = c.id
     WHERE c."tenantId" = $1
       AND (c."businessName" ~* '<\\w+' OR c."businessName" ILIKE '%XSS%')
     GROUP BY c.id, c."businessName"
     HAVING COUNT(DISTINCT o.id) = 0
        AND COUNT(DISTINCT inv.id) = 0`,
    [TARGET_TENANT_ID],
  );

  if (candidateRes.rows.length === 0) {
    console.log("[purge-xss-names] No matching Customer rows found — tenant is already clean.");
    await client.end();
    return;
  }

  console.log(`[purge-xss-names] Found ${candidateRes.rows.length} candidate(s):`);
  for (const row of candidateRes.rows) {
    console.log(`  id=${row.id}  name=${JSON.stringify(row.businessName)}`);
  }

  // 4. Delete the candidates (only the rows meeting all criteria above).
  const ids = candidateRes.rows.map((r) => r.id);
  // Parameterised deletion — one round-trip, no string interpolation.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const deleteRes = await client.query(`DELETE FROM "Customer" WHERE id IN (${placeholders})`, ids);

  console.log(`[purge-xss-names] Deleted ${deleteRes.rowCount} Customer row(s).`);

  await client.end();
}

main().catch((err) => {
  console.error("[purge-xss-names] Fatal error:", err);
  process.exit(1);
});
