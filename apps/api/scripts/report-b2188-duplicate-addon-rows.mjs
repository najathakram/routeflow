/**
 * READ-ONLY count for #2188 / SA-385 (6): how many tenants hold MORE THAN ONE active TenantAddon
 * row for the same canonical SKU today. Before #2188, admin enableAddon keyed a row on the raw legacy
 * addonKey (e.g. "tobacco_dealer") while subscribe()/self-serve keyed it on the SKU
 * ("REGULATED_ITEMS"), so the (tenantId, addonKey) unique could not stop a pair. #2188 stops new
 * pairs; it does not dedupe existing ones. Count 0 means nothing to decide; > 0 is its own ruling.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-b2188-duplicate-addon-rows.mjs [--json]
 *
 * Output is COUNTS ONLY plus anonymous labels ("tenant A", "tenant B", …): no tenant id, slug or
 * name is printed. Test tenants (scripts/lib/test-tenants.cjs) are counted in a separate `test`
 * block. `--tenant <id>` limits the count to one tenant (DB-lane use only).
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` caps
 * every query; the connection is closed in `finally`; only SELECT appears below.
 */
import { createRequire } from "module";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

/**
 * Mirror of LEGACY_ADDON_KEY_TO_SKU (apps/api/src/billing/plan-catalog.constants.ts). A .mjs
 * cannot import the TS map; report-b2188-duplicate-addon-rows.spec.ts pins the two deep-equal.
 */
export const LEGACY_ADDON_KEY_TO_SKU = {
  tobacco_dealer: "REGULATED_ITEMS",
  msrp: "MSRP",
  sales_agents: "SALES_AGENTS",
  ocr: "OCR_PACK_250",
};

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const tenantArg = argv.indexOf("--tenant");
  const onlyTenant = tenantArg >= 0 ? argv[tenantArg + 1] : null;
  if (tenantArg >= 0 && !onlyTenant) {
    console.error("report-b2188-duplicate-addon-rows: --tenant needs a tenant id");
    process.exit(2);
  }
  const databaseUrl = resolveReportDbUrl("report-b2188-duplicate-addon-rows");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");

    const legacyKeys = Object.keys(LEGACY_ADDON_KEY_TO_SKU);
    const legacySkus = legacyKeys.map((k) => LEGACY_ADDON_KEY_TO_SKU[k]);
    const { rows } = await client.query(
      `WITH legacy AS (SELECT * FROM unnest($1::text[], $2::text[]) AS m(key, sku)),
            canon AS (
              SELECT a."tenantId", t.slug,
                     COALESCE(a.sku, l.sku, a."addonKey") AS code
                FROM "TenantAddon" a
                JOIN "Tenant" t ON t.id = a."tenantId"
                LEFT JOIN legacy l ON l.key = a."addonKey"
               WHERE a.active = true AND ($3::text IS NULL OR a."tenantId" = $3::text))
       SELECT "tenantId", slug, code, COUNT(*)::int AS rows
         FROM canon GROUP BY "tenantId", slug, code HAVING COUNT(*) > 1
        ORDER BY "tenantId", code`,
      [legacyKeys, legacySkus, onlyTenant],
    );

    const report = {
      live: summarize(rows.filter((r) => !isTestTenant(r.slug))),
      test: summarize(rows.filter((r) => isTestTenant(r.slug))),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, s] of Object.entries(report)) {
        console.log(`${block}: ${s.tenants} tenant(s), ${s.groups} duplicated sku group(s)`);
        for (const g of s.detail) console.log(`  ${g.tenant}  ${g.sku}  ${g.rows} active rows`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Anonymous per-tenant labels (A, B, …) in tenantId order; ids and slugs never leave this function. */
export function summarize(rows) {
  const label = new Map();
  const detail = rows.map((r) => {
    if (!label.has(r.tenantId))
      label.set(
        r.tenantId,
        `tenant ${String.fromCharCode(65 + (label.size % 26))}${label.size >= 26 ? Math.floor(label.size / 26) : ""}`,
      );
    return { tenant: label.get(r.tenantId), sku: r.code, rows: r.rows };
  });
  return { tenants: label.size, groups: rows.length, detail };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`report-b2188-duplicate-addon-rows: ${e.message}`);
    process.exit(1);
  });
}
