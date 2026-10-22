/**
 * READ-ONLY census for row 640 (SA-834): how many GRANT overrides a configuration-snapshot restore
 * has re-created on a billable add-on key (ocr -> OCR_PACK_250, tobacco_dealer -> REGULATED_ITEMS),
 * split by override kind, and how many of the non-COMP ones sit on a tenant with NO active non-comp
 * priced row for that SKU (the harm: a free grant nobody pays for). COMP is restored as-was by
 * design, so it is reported but is not the harm.
 *
 * A restored override carries no marker, so it is matched to a restored snapshot by tenant + a
 * 10 s window: a GRANT row created at or after `restoredAt` and within 10 s of it. The match is
 * approximate (a coincident admin grant would count) and says so in the output.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its standing read-only yes:
 *
 *   railway run --service postgres node apps/api/scripts/report-640-restored-grants.mjs [--json]
 *
 * Output is COUNTS ONLY: no tenant id, slug or name is printed. `--self-test` runs the pure checks
 * with no database and exits.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and
 * `lock_timeout` cap every query; the connection is closed in `finally`; only SELECT appears below.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");

/** The billable add-on keys the restore verdict judges (feature-registry `billing.skus`). */
export const BILLABLE_KEYS = {
  ocr: "OCR_PACK_250",
  tobacco_dealer: "REGULATED_ITEMS",
};
export const WINDOW_SECONDS = 10;

/** Pure: fold census rows into counts only. */
export function summarize(rows) {
  const byKind = {};
  let uncoveredNonComp = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
    if (r.kind !== "COMP" && !r.hasPricedRow) uncoveredNonComp += r.n;
  }
  return {
    restoredGrants: rows.reduce((t, r) => t + r.n, 0),
    byKind,
    nonCompWithoutPricedRow: uncoveredNonComp,
    note: `matched by a ${WINDOW_SECONDS}s window after restoredAt; approximate`,
  };
}

export function selfTest() {
  const s = summarize([
    { kind: "COMP", n: 2, hasPricedRow: false },
    { kind: "PILOT", n: 1, hasPricedRow: false },
    { kind: "TRIAL", n: 3, hasPricedRow: true },
  ]);
  if (s.restoredGrants !== 6 || s.nonCompWithoutPricedRow !== 1 || s.byKind.COMP !== 2)
    throw new Error(`summarize: ${JSON.stringify(s)}`);
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl("report-640-restored-grants");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");

    const keys = Object.keys(BILLABLE_KEYS);
    const skus = keys.map((k) => BILLABLE_KEYS[k]);
    const snapshots = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE "restoredAt" IS NOT NULL AND "restoredToPlanKey" <> 'SUPERSEDED')::int AS restored
         FROM "TenantFeatureConfigSnapshot"`,
    );
    const { rows } = await client.query(
      `WITH map AS (SELECT * FROM unnest($1::text[], $2::text[]) AS m(key, sku))
       SELECT o.kind::text AS kind,
              COUNT(*)::int AS n,
              EXISTS (
                SELECT 1 FROM "TenantAddon" a
                 WHERE a."tenantId" = o."tenantId" AND a.active = true AND a."isComp" = false
                   AND a."priceSnapshot" > 0
                   AND COALESCE(a.sku, m.sku) = m.sku
                   AND a."addonKey" IN (m.key, m.sku)
              ) AS "hasPricedRow"
         FROM "TenantFeatureOverride" o
         JOIN map m ON m.key = o."featureKey"
         JOIN "TenantFeatureConfigSnapshot" s
           ON s."tenantId" = o."tenantId"
          AND s."restoredAt" IS NOT NULL
          AND s."restoredToPlanKey" <> 'SUPERSEDED'
          AND o."createdAt" >= s."restoredAt"
          AND o."createdAt" < s."restoredAt" + make_interval(secs => $3)
        WHERE o.effect = 'GRANT'
        GROUP BY o.kind, o."tenantId", m.key, m.sku`,
      [keys, skus, WINDOW_SECONDS],
    );
    const out = {
      snapshots: snapshots.rows[0],
      ...summarize(rows.map((r) => ({ kind: r.kind, n: r.n, hasPricedRow: r.hasPricedRow }))),
    };
    console.log(
      json ? JSON.stringify(out) : `row 640 census (counts only):\n${JSON.stringify(out, null, 2)}`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

const entry = process.argv[1] ? basename(realpathSync(process.argv[1])) : "";
if (entry === basename(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`report-640-restored-grants failed: ${e.message}`);
    process.exit(1);
  });
}
