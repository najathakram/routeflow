/**
 * READ-ONLY census for row 621 (SA-971): how many unit rows disagree with "the base level is the 1-piece
 * level, named by the product's base word". Three counts, no row ids, no tenant names in the output:
 *   (i)   units of more than 1 piece named like the product's base word, or "piece"   (orphans if > 0)
 *   (ii)  1-piece units named neither (a billed piece price would change; owner question if > 0)
 *   (iii) products with a non-empty baseUnitLabel (a custom base word)
 * Keys use the units SQL key (`sqlKeyOf`, src/units/unit-name-sql.ts), so SQL agrees with TypeScript.
 *
 *   node apps/api/scripts/census-base-label-row621.mjs --tenant <test-tenant-slug>   (local/test DB)
 *   railway run --service postgres node apps/api/scripts/census-base-label-row621.mjs --all   (owner's yes)
 *
 * SAFETY: `default_transaction_read_only = on` before any query; statement_timeout; SELECTs only.
 * `--tenant` must pass assertTestTenant. `--all` reads every tenant and prints only totals.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

// Every UTF-16 unit JavaScript trim() strips (pinned equal to sqlKeyOf by census-base-label-row621.spec.ts).
const JS_TRIM_CODE_UNITS = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
];
const SQL_TRIM_SET = JS_TRIM_CODE_UNITS.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join(
  "",
);
export const keyOf = (ref) => `lower(btrim(normalize(${ref}, NFC), E'${SQL_TRIM_SET}'))`;

const BASE_KEY = keyOf(`coalesce(nullif(btrim(p."baseUnitLabel"), ''), 'Piece')`);
const SCOPE = `($1::text IS NULL OR p."tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1))`;

export const COUNTS_SQL = `
SELECT
  count(*) FILTER (WHERE pu."factorToBase" <> 1
    AND (${keyOf(`pu.label`)} = ${BASE_KEY} OR ${keyOf(`pu.label`)} = 'piece'))::int AS "i_multiPieceNamedBase",
  count(*) FILTER (WHERE pu."factorToBase" = 1
    AND ${keyOf(`pu.label`)} <> ${BASE_KEY} AND ${keyOf(`pu.label`)} <> 'piece')::int AS "ii_onePieceNamedOther",
  count(*)::int AS "unitRows"
FROM "ProductUnit" pu JOIN "Product" p ON p.id = pu."productId"
WHERE ${SCOPE}`;

export const PRODUCTS_SQL = `
SELECT count(*) FILTER (WHERE nullif(btrim(p."baseUnitLabel"), '') IS NOT NULL)::int AS "iii_customBaseWord",
       count(*)::int AS products
FROM "Product" p WHERE ${SCOPE}`;

async function main(argv) {
  const all = argv.includes("--all");
  const i = argv.indexOf("--tenant");
  const slug = i >= 0 ? argv[i + 1] : null;
  if (all === (slug != null)) {
    console.error("usage: --tenant <test-tenant-slug> | --all");
    return 2;
  }
  if (slug) assertTestTenant(slug, "census-base-label-row621");
  const url = resolveReportDbUrl("census-base-label-row621");
  if (!url) return 2;
  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    const [u] = (await client.query(COUNTS_SQL, [slug])).rows;
    const [p] = (await client.query(PRODUCTS_SQL, [slug])).rows;
    console.log(JSON.stringify({ scope: slug ?? "all", ...u, ...p }, null, 2));
  } finally {
    await client.end();
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
