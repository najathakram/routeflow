/**
 * Tidy Regulated Categories — one-time data cleanup for the Type-vs-Category fix
 * -------------------------------------------------------------------------------
 * Legacy rows have `Product.category` set to the regulated TYPE name (e.g.
 * "Tobacco") instead of the structured CATEGORY name (e.g. "Zyn") or free
 * text. This script aligns every regulated product's `category` with the new
 * one-category-axis model:
 *
 *   1. Where category == the product's TrackedCategory (type) name (case/
 *      whitespace-insensitive): replace with the TrackedSubcategory (category)
 *      name if one is set, else clear it (NULL).
 *   2. Where a TrackedSubcategory IS set but category is NULL or diverges from
 *      the subcategory's name: align category to the subcategory's name.
 *
 * Idempotent — safe to re-run; a second run reports zero rows to change.
 *
 * Modes:
 *   node apps/api/scripts/tidy-regulated-categories.mjs --tenant <slug>          # DRY RUN
 *   node apps/api/scripts/tidy-regulated-categories.mjs --tenant <slug> --execute
 *   node apps/api/scripts/tidy-regulated-categories.mjs --all-tenants            # DRY RUN, OWNER only
 *   node apps/api/scripts/tidy-regulated-categories.mjs --all-tenants --execute
 *
 * `--tenant <slug>` is guarded by assertTestTenant (fail-closed — only
 * approved test tenants). `--all-tenants` skips that guard: it is the
 * OWNER's prod-migration mode, meant to be run via
 * `railway run --service postgres node apps/api/scripts/tidy-regulated-categories.mjs --all-tenants --execute`.
 */

"use strict";

import { Client } from "pg";
import { assertTestTenant } from "../../../scripts/lib/test-tenants.cjs";

// Connection resolution mirrors prod-migrate.mjs: `railway run --service postgres`
// does NOT set DATABASE_URL — the postgres service exposes credential PARTS
// (POSTGRES_* + the public TCP proxy host/port), so build the URL from them.
// A directly-set DATABASE_URL (local docker, CI) still wins.
function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const e = process.env;
  const need = [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "RAILWAY_TCP_PROXY_DOMAIN",
    "RAILWAY_TCP_PROXY_PORT",
  ];
  const missing = need.filter((k) => !e[k]);
  if (missing.length) {
    console.error(
      `Missing env: ${missing.join(", ")}\n` +
        "Set DATABASE_URL, or run via: railway run --service postgres node apps/api/scripts/tidy-regulated-categories.mjs",
    );
    process.exit(1);
  }
  console.log(`Target host: ${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}`);
  return (
    `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
    `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
  );
}
const DB_URL = resolveDbUrl();

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const ALL_TENANTS = argv.includes("--all-tenants");
const tenantFlagIdx = argv.indexOf("--tenant");
const TENANT_ARG = tenantFlagIdx !== -1 ? argv[tenantFlagIdx + 1] : undefined;

if (!ALL_TENANTS && !TENANT_ARG) {
  console.error(
    "Usage: node apps/api/scripts/tidy-regulated-categories.mjs --tenant <slug> [--execute]\n" +
      "   or: node apps/api/scripts/tidy-regulated-categories.mjs --all-tenants [--execute]",
  );
  process.exit(1);
}

if (ALL_TENANTS && TENANT_ARG) {
  console.error("Pass either --tenant <slug> or --all-tenants, not both.");
  process.exit(1);
}

let TENANT_SLUG;
if (!ALL_TENANTS) {
  TENANT_SLUG = assertTestTenant(TENANT_ARG, "tidy-regulated-categories");
}

function ok(msg) {
  console.log(`   ✓ ${msg}`);
}
function step(msg) {
  console.log(`\n${"─".repeat(60)}\n  ${msg}`);
}

/**
 * Class 1: products whose free-text category equals their regulated TYPE
 * name (case/whitespace-insensitive) → sub name (if set) or NULL.
 */
async function tidyTypeNameLeakage(pg, tenantId) {
  const rows = await pg.query(
    `SELECT p.id, p.category, p."trackedSubcategoryId", ts.name AS sub_name
       FROM "Product" p
       JOIN "TrackedCategory" tc ON tc.id = p."trackedCategoryId"
       LEFT JOIN "TrackedSubcategory" ts ON ts.id = p."trackedSubcategoryId"
      WHERE p."tenantId" = $1
        AND p."trackedCategoryId" IS NOT NULL
        AND p.category IS NOT NULL
        AND LOWER(TRIM(p.category)) = LOWER(TRIM(tc.name))`,
    [tenantId],
  );

  const toSubName = rows.rows.filter((r) => r.sub_name && r.sub_name !== r.category);
  const toNull = rows.rows.filter((r) => !r.sub_name);

  if (EXECUTE) {
    for (const r of toSubName) {
      await pg.query(`UPDATE "Product" SET category = $1 WHERE id = $2`, [r.sub_name, r.id]);
    }
    if (toNull.length) {
      await pg.query(`UPDATE "Product" SET category = NULL WHERE id = ANY($1::text[])`, [
        toNull.map((r) => r.id),
      ]);
    }
  }

  return { toSubName: toSubName.length, toNull: toNull.length };
}

/**
 * Class 2: products with a structured category (trackedSubcategoryId set)
 * whose category is NULL or diverges from the subcategory's name → align.
 */
async function tidyDivergedStructured(pg, tenantId) {
  const rows = await pg.query(
    `SELECT p.id, p.category, ts.name AS sub_name
       FROM "Product" p
       JOIN "TrackedSubcategory" ts ON ts.id = p."trackedSubcategoryId"
      WHERE p."tenantId" = $1
        AND p."trackedSubcategoryId" IS NOT NULL
        AND (p.category IS NULL OR p.category <> ts.name)`,
    [tenantId],
  );

  if (EXECUTE) {
    for (const r of rows.rows) {
      await pg.query(`UPDATE "Product" SET category = $1 WHERE id = $2`, [r.sub_name, r.id]);
    }
  }

  return { aligned: rows.rows.length };
}

async function tidyTenant(pg, tenant) {
  step(`Tenant ${tenant.slug} (${tenant.id})`);
  const class1 = await tidyTypeNameLeakage(pg, tenant.id);
  const class2 = await tidyDivergedStructured(pg, tenant.id);

  ok(
    `Type-name leakage: ${class1.toSubName} → sub name, ${class1.toNull} → NULL${
      EXECUTE ? "" : " (dry run)"
    }`,
  );
  ok(`Diverged structured categories aligned: ${class2.aligned}${EXECUTE ? "" : " (dry run)"}`);

  return {
    slug: tenant.slug,
    typeLeakageToSubName: class1.toSubName,
    typeLeakageToNull: class1.toNull,
    divergedAligned: class2.aligned,
  };
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  RouteFlow — Tidy Regulated Categories                  ║");
  console.log(`║  Mode: ${(EXECUTE ? "EXECUTE (writes)" : "DRY RUN").padEnd(50)}║`);
  console.log(`║  Scope: ${(ALL_TENANTS ? "ALL TENANTS" : TENANT_SLUG).padEnd(49)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (ALL_TENANTS) {
    console.log("\n⚠️  ⚠️  ⚠️   ALL-TENANTS MODE  ⚠️  ⚠️  ⚠️");
    console.log("This touches EVERY tenant's product categories, including live client data.");
    console.log("This mode is for the OWNER only, run against prod via:");
    console.log(
      "  railway run --service postgres node apps/api/scripts/tidy-regulated-categories.mjs --all-tenants --execute",
    );
    if (!EXECUTE) {
      console.log("Currently in DRY RUN — no writes will be made.\n");
    }
  }

  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  try {
    let tenants;
    if (ALL_TENANTS) {
      const r = await pg.query(`SELECT id, slug FROM "Tenant" ORDER BY slug`);
      tenants = r.rows;
    } else {
      const r = await pg.query(`SELECT id, slug FROM "Tenant" WHERE slug = $1`, [TENANT_SLUG]);
      if (!r.rows[0]) {
        console.error(`Tenant ${TENANT_SLUG} not found`);
        process.exit(1);
      }
      tenants = r.rows;
    }

    const results = [];
    for (const tenant of tenants) {
      results.push(await tidyTenant(pg, tenant));
    }

    console.log(`\n${"═".repeat(65)}`);
    console.log(`  ${EXECUTE ? "EXECUTE" : "DRY RUN"} SUMMARY — per tenant`);
    console.log(`${"═".repeat(65)}`);
    for (const r of results) {
      console.log(
        `  ${r.slug.padEnd(30)} leakage→sub:${r.typeLeakageToSubName}  leakage→null:${
          r.typeLeakageToNull
        }  aligned:${r.divergedAligned}`,
      );
    }
    const totals = results.reduce(
      (acc, r) => ({
        typeLeakageToSubName: acc.typeLeakageToSubName + r.typeLeakageToSubName,
        typeLeakageToNull: acc.typeLeakageToNull + r.typeLeakageToNull,
        divergedAligned: acc.divergedAligned + r.divergedAligned,
      }),
      { typeLeakageToSubName: 0, typeLeakageToNull: 0, divergedAligned: 0 },
    );
    console.log(`${"─".repeat(65)}`);
    console.log(
      `  TOTAL: leakage→sub:${totals.typeLeakageToSubName}  leakage→null:${totals.typeLeakageToNull}  aligned:${totals.divergedAligned}`,
    );
    console.log(`${"═".repeat(65)}`);
    if (!EXECUTE) {
      console.log("\nRe-run with --execute to apply changes.\n");
    } else {
      console.log("\n✅ Tidy complete.\n");
    }
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error("\n❌ Tidy failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
