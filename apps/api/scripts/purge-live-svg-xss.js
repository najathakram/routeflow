/**
 * purge-live-svg-xss.js
 * ─────────────────────
 * Deletes SVG files that were uploaded before the RF-076/RF-157 MIME allowlist
 * was enforced. Targets ONLY the ux-audit tenant — never any live client
 * tenant (enforced via assertTestTenant).
 *
 * What it does:
 *   1. Queries ProductImage rows (via Product.imageKeys) where the key ends in
 *      ".svg" or the stored mimetype is "image/svg+xml".
 *   2. Queries CustomerTaxDocument rows with the same conditions.
 *   3. Deletes the underlying files from disk (or R2 if configured).
 *   4. Removes the DB references (updates Product.imageKeys array, deletes
 *      CustomerDocument rows).
 *   5. Logs every row touched. Idempotent — safe to re-run.
 *
 * DO NOT RUN until the new allowlist code has been deployed.
 * Run from repo root:
 *   node apps/api/scripts/purge-live-svg-xss.js
 */

"use strict";

const { Client } = require("pg");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

// ── Config ────────────────────────────────────────────────────────────────────

const TARGET_TENANT_SLUG = "ux-audit-1777265477001";
assertTestTenant(TARGET_TENANT_SLUG, "purge-live-svg-xss");

// Reads DATABASE_URL from apps/api/.env if present, else from the environment.
function resolveDatabaseUrl() {
  const envPath = path.join(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf8");
    const match = raw.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
    if (match) return match[1];
  }
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  console.error(
    "[purge-svg-xss] DATABASE_URL not set. Run via: railway run --service postgres node apps/api/scripts/purge-live-svg-xss.js",
  );
  process.exit(1);
}

// Local upload directory — mirrors StorageService default.
function resolveUploadDir() {
  return process.env.UPLOAD_DIR || path.join(os.tmpdir(), "routeflow-uploads");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSvgKey(key) {
  return key.toLowerCase().endsWith(".svg");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dbUrl = resolveDatabaseUrl();
  const uploadDir = resolveUploadDir();

  console.log(`[purge-svg-xss] Connecting to DB…`);
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  // 1. Resolve the tenant id for the target slug.
  const tenantRes = await client.query('SELECT id, slug FROM "Tenant" WHERE slug = $1 LIMIT 1', [
    TARGET_TENANT_SLUG,
  ]);
  if (tenantRes.rows.length === 0) {
    console.log(`[purge-svg-xss] Tenant "${TARGET_TENANT_SLUG}" not found — nothing to do.`);
    await client.end();
    return;
  }
  const tenantId = tenantRes.rows[0].id;
  console.log(`[purge-svg-xss] Target tenant: ${TARGET_TENANT_SLUG} (id=${tenantId})`);

  // Safety: double-check the resolved slug is still an approved test tenant.
  try {
    assertTestTenant(tenantRes.rows[0].slug, "purge-live-svg-xss resolved tenant");
  } catch (err) {
    console.error(`[purge-svg-xss] ABORT: ${err.message}`);
    await client.end();
    process.exit(1);
  }

  let totalDeleted = 0;

  // ── 2. Product image keys ─────────────────────────────────────────────────

  const productRes = await client.query(
    `SELECT id, "imageKeys" FROM "Product" WHERE "tenantId" = $1 AND "imageKeys" && ARRAY(
       SELECT unnest("imageKeys") FROM "Product" WHERE "tenantId" = $1
       -- postgres can't filter array elements inline, so pull all and filter in JS
     )`,
    [tenantId],
  );

  // Simpler: fetch all products for the tenant and filter in JS.
  const allProductsRes = await client.query(
    `SELECT id, "imageKeys" FROM "Product" WHERE "tenantId" = $1`,
    [tenantId],
  );

  for (const row of allProductsRes.rows) {
    const svgKeys = (row.imageKeys || []).filter(isSvgKey);
    if (svgKeys.length === 0) continue;

    // Delete files from disk.
    for (const key of svgKeys) {
      const filePath = path.join(uploadDir, key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[purge-svg-xss] Deleted file: ${filePath}`);
      } else {
        console.log(`[purge-svg-xss] File not on disk (may be in R2): ${key}`);
      }
    }

    // Update imageKeys to remove the svg entries.
    const remaining = (row.imageKeys || []).filter((k) => !isSvgKey(k));
    await client.query(`UPDATE "Product" SET "imageKeys" = $1 WHERE id = $2`, [remaining, row.id]);
    console.log(
      `[purge-svg-xss] Product ${row.id}: removed ${svgKeys.length} SVG key(s): ${svgKeys.join(", ")}`,
    );
    totalDeleted += svgKeys.length;
  }

  // ── 3. Customer tax documents ─────────────────────────────────────────────

  // CustomerDocument table stores taxDocumentKeys on the Customer record or as a
  // separate table — check both patterns.
  // Pattern A: Customer.taxDocumentKeys (string[])
  const custColRes = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'Customer' AND column_name = 'taxDocumentKeys'`,
  );

  if (custColRes.rows.length > 0) {
    const taxRes = await client.query(
      `SELECT id, "taxDocumentKeys" FROM "Customer" WHERE "tenantId" = $1`,
      [tenantId],
    );
    for (const row of taxRes.rows) {
      const svgKeys = (row.taxDocumentKeys || []).filter(isSvgKey);
      if (svgKeys.length === 0) continue;

      for (const key of svgKeys) {
        const filePath = path.join(uploadDir, key);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`[purge-svg-xss] Deleted file: ${filePath}`);
        } else {
          console.log(`[purge-svg-xss] File not on disk (may be in R2): ${key}`);
        }
      }

      const remaining = (row.taxDocumentKeys || []).filter((k) => !isSvgKey(k));
      await client.query(`UPDATE "Customer" SET "taxDocumentKeys" = $1 WHERE id = $2`, [
        remaining,
        row.id,
      ]);
      console.log(
        `[purge-svg-xss] Customer ${row.id}: removed ${svgKeys.length} SVG tax-doc key(s): ${svgKeys.join(", ")}`,
      );
      totalDeleted += svgKeys.length;
    }
  }

  // Pattern B: CustomerDocument table with a `key` column
  const docTableRes = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name = 'CustomerDocument'`,
  );
  if (docTableRes.rows.length > 0) {
    const docRes = await client.query(
      `SELECT cd.id, cd.key FROM "CustomerDocument" cd
       JOIN "Customer" c ON cd."customerId" = c.id
       WHERE c."tenantId" = $1 AND (cd.key ILIKE '%.svg' OR cd.mimetype = 'image/svg+xml')`,
      [tenantId],
    );
    for (const row of docRes.rows) {
      const filePath = path.join(uploadDir, row.key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[purge-svg-xss] Deleted file: ${filePath}`);
      } else {
        console.log(`[purge-svg-xss] File not on disk (may be in R2): ${row.key}`);
      }

      await client.query(`DELETE FROM "CustomerDocument" WHERE id = $1`, [row.id]);
      console.log(`[purge-svg-xss] Deleted CustomerDocument row id=${row.id} key=${row.key}`);
      totalDeleted++;
    }
  }

  // ── 4. Summary ────────────────────────────────────────────────────────────

  if (totalDeleted === 0) {
    console.log("[purge-svg-xss] No SVG records found — tenant is already clean.");
  } else {
    console.log(`[purge-svg-xss] Done. Removed ${totalDeleted} SVG reference(s).`);
  }

  await client.end();
}

main().catch((err) => {
  console.error("[purge-svg-xss] Fatal error:", err);
  process.exit(1);
});
