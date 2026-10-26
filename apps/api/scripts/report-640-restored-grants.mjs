/**
 * READ-ONLY census for row 640 (SA-834): how many GRANT overrides a configuration-snapshot restore
 * has re-created on a billable add-on key (ocr -> OCR_PACK_250, tobacco_dealer -> REGULATED_ITEMS),
 * split by override kind, and how many of the non-COMP ones sit on a tenant with NO active non-comp
 * priced row for that SKU (the harm: a free grant nobody pays for). COMP is restored as-was by
 * design, so it is reported but is not the harm.
 *
 * A restored override carries no marker, so it is matched to a restored snapshot by tenant + a
 * 10 s window: a GRANT row created at or after `restoredAt` and within 10 s of it. A PARTIAL restore
 * (BO-13 held row) is never stamped, so its grants are reported SEPARATELY as `unstampedPossible`,
 * matched via the CONFIG_SNAPSHOT_RESTORE_HELD audit row written in the same transaction. "Billable"
 * also requires the published catalog AddonSku to carry a price. Every limit is printed in `limits`
 * (text and --json): the counts are approximate and say so.
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
export const HELD_ACTION = "CONFIG_SNAPSHOT_RESTORE_HELD";

/** Plain-words limits, printed in text and `--json` so nobody reads the counts as exact. */
export const LIMITS = [
  `stamped restores are matched by a ${WINDOW_SECONDS}s window after restoredAt; a coincident admin grant would count`,
  `unstamped-possible = a GRANT created within ${WINDOW_SECONDS}s before a ${HELD_ACTION} audit row (a partial restore leaves the snapshot unstamped); the audit row is the only signal, so an admin grant in the same window would count, and a partial restore with no audit row is invisible`,
  "billable = the catalog version the tenant is pinned to (subscription pin, else tenant pin, else the latest PUBLISHED, the order plan-version-pin.ts uses) lists the SKU with monthlyPrice > 0; a plan that bundles the SKU (includedAtPlan) is NOT evaluated, so a grant on a bundling plan may be reported as harm",
  "inactive = revoked, or expired at the time of the run; an inactive grant is counted in inactiveGrants and is never harm",
];

/** Exit code when the catalog cannot answer the price question: a harm count of 0 would then mean nothing. */
export const CATALOG_EXIT_CODE = 3;

/**
 * Pure: why the price test cannot run, or null. `published` = PUBLISHED PlanVersion rows; `skuRows` = AddonSku rows on
 * the latest PUBLISHED version for the billable SKUs. An empty catalog must fail closed, never read as "no harm".
 */
export function catalogProblem({ published, skuRows }) {
  if (!published)
    return "no PUBLISHED plan version: the price test cannot run, so a harm count would be meaningless (run the catalog publisher first)";
  if (!skuRows)
    return `the latest PUBLISHED plan version lists none of ${Object.values(BILLABLE_KEYS).join(", ")}: the price test cannot run`;
  return null;
}

const bump = (m, k, n) => {
  m[k] = (m[k] ?? 0) + n;
};

/**
 * Pure: fold census rows into counts only. A row is `{ kind, n, hasPricedRow, signal?, catalogPriced?, active? }`
 * where `signal` is "stamped" (default) or "unstamped", `catalogPriced === false` means the tenant's catalog version
 * does not price the SKU (a free grant there is not the harm), and `active === false` means the grant is revoked or
 * expired: counted in `inactiveGrants`, never in the harm column.
 */
export function summarize(rows) {
  const byKind = {};
  const unByKind = {};
  let uncovered = 0;
  let unUncovered = 0;
  let stamped = 0;
  let unstamped = 0;
  let inactive = 0;
  let unInactive = 0;
  for (const r of rows) {
    const live = r.active !== false;
    const harm = live && r.kind !== "COMP" && !r.hasPricedRow && r.catalogPriced !== false;
    if (r.signal === "unstamped") {
      unstamped += r.n;
      bump(unByKind, r.kind, r.n);
      if (!live) unInactive += r.n;
      if (harm) unUncovered += r.n;
    } else {
      stamped += r.n;
      bump(byKind, r.kind, r.n);
      if (!live) inactive += r.n;
      if (harm) uncovered += r.n;
    }
  }
  return {
    restoredGrants: stamped,
    byKind,
    nonCompWithoutPricedRow: uncovered,
    inactiveGrants: inactive,
    unstampedPossible: {
      grants: unstamped,
      byKind: unByKind,
      nonCompWithoutPricedRow: unUncovered,
      inactiveGrants: unInactive,
    },
    limits: LIMITS,
    note: LIMITS[0],
  };
}

export function selfTest() {
  const s = summarize([
    { kind: "COMP", n: 2, hasPricedRow: false },
    { kind: "PILOT", n: 1, hasPricedRow: false },
    { kind: "TRIAL", n: 3, hasPricedRow: true },
    { kind: "TRIAL", n: 4, hasPricedRow: false, catalogPriced: false },
    { kind: "PILOT", n: 3, hasPricedRow: false, signal: "unstamped", catalogPriced: true },
    { kind: "PILOT", n: 2, hasPricedRow: false, active: false }, // revoked or expired: not harm
    { kind: "PILOT", n: 1, hasPricedRow: false, signal: "unstamped", active: false },
  ]);
  if (
    s.restoredGrants !== 12 ||
    s.nonCompWithoutPricedRow !== 1 ||
    s.inactiveGrants !== 2 ||
    s.byKind.COMP !== 2 ||
    s.unstampedPossible.grants !== 4 ||
    s.unstampedPossible.nonCompWithoutPricedRow !== 3 ||
    s.unstampedPossible.inactiveGrants !== 1
  )
    throw new Error(`summarize: ${JSON.stringify(s)}`);
  if (catalogProblem({ published: 0, skuRows: 0 }) == null) throw new Error("empty catalog passed");
  if (catalogProblem({ published: 1, skuRows: 0 }) == null) throw new Error("unlisted SKUs passed");
  if (catalogProblem({ published: 1, skuRows: 2 }) != null) throw new Error("good catalog refused");
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
    // Fail closed: with no PUBLISHED catalog (or one that lists none of the billable SKUs) every grant would read as
    // "not priced" and the census would report a harm count of 0 that means nothing.
    const catalog = await client.query(
      `SELECT (SELECT COUNT(*) FROM "PlanVersion" WHERE status = 'PUBLISHED')::int AS published,
              (SELECT COUNT(*) FROM "AddonSku" k
                 JOIN (SELECT id FROM "PlanVersion" WHERE status = 'PUBLISHED' ORDER BY version DESC LIMIT 1) v
                   ON v.id = k."planVersionId"
                WHERE k.sku = ANY($1::text[]))::int AS "skuRows"`,
      [skus],
    );
    const problem = catalogProblem(catalog.rows[0]);
    if (problem) {
      console.error(`report-640-restored-grants: ${problem}`);
      process.exitCode = CATALOG_EXIT_CODE;
      return;
    }

    // One row per override, then counted: the price test reads the version the TENANT is pinned to
    // (subscription pin, else tenant pin, else the latest PUBLISHED: plan-version-pin.ts), and a revoked or expired
    // grant is `active = false`.
    const inner = (
      extraWhere,
    ) => `WITH map AS (SELECT * FROM unnest($1::text[], $2::text[]) AS m(key, sku)),
       pub AS (SELECT id FROM "PlanVersion" WHERE status = 'PUBLISHED' ORDER BY version DESC LIMIT 1)
       SELECT kind, sku, "hasPricedRow", "catalogPriced", active, COUNT(*)::int AS n FROM (
         SELECT o.kind::text AS kind,
                m.sku AS sku,
                EXISTS (
                  SELECT 1 FROM "TenantAddon" a
                   WHERE a."tenantId" = o."tenantId" AND a.active = true AND a."isComp" = false
                     AND a."priceSnapshot" > 0
                     AND COALESCE(a.sku, m.sku) = m.sku
                     AND a."addonKey" IN (m.key, m.sku)
                ) AS "hasPricedRow",
                EXISTS (
                  SELECT 1 FROM "AddonSku" k
                   WHERE k."planVersionId" = COALESCE(ts."planVersionId", t."planVersionId", (SELECT id FROM pub))
                     AND k.sku = m.sku AND k."monthlyPrice" > 0
                ) AS "catalogPriced",
                (o."revokedAt" IS NULL AND (o."expiresAt" IS NULL OR o."expiresAt" > now())) AS active
           FROM "TenantFeatureOverride" o
           JOIN map m ON m.key = o."featureKey"
           JOIN "Tenant" t ON t.id = o."tenantId"
           LEFT JOIN "TenantSubscription" ts ON ts."tenantId" = o."tenantId"
          WHERE o.effect = 'GRANT' AND ${extraWhere}
       ) x
       GROUP BY kind, sku, "hasPricedRow", "catalogPriced", active`;
    const stampedWindow = `s."tenantId" = o."tenantId"
          AND s."restoredAt" IS NOT NULL
          AND s."restoredToPlanKey" <> 'SUPERSEDED'
          AND o."createdAt" >= s."restoredAt"
          AND o."createdAt" < s."restoredAt" + make_interval(secs => $3)`;
    const stampedRows = await client.query(
      inner(`EXISTS (SELECT 1 FROM "TenantFeatureConfigSnapshot" s WHERE ${stampedWindow})`),
      [keys, skus, WINDOW_SECONDS],
    );
    // Unstamped partial restores: a HELD audit row (written in the same transaction, just after the
    // override rows) for the tenant; any override the stamped match already counted is excluded.
    const unstampedRows = await client.query(
      inner(`EXISTS (
            SELECT 1 FROM "AuditLog" l
             WHERE l."tenantId" = o."tenantId" AND l.action = $4
               AND o."createdAt" <= l."createdAt"
               AND o."createdAt" > l."createdAt" - make_interval(secs => $3))
          AND NOT EXISTS (
            SELECT 1 FROM "TenantFeatureConfigSnapshot" s WHERE ${stampedWindow})`),
      [keys, skus, WINDOW_SECONDS, HELD_ACTION],
    );
    const toRow = (signal) => (r) => ({
      kind: r.kind,
      n: r.n,
      hasPricedRow: r.hasPricedRow,
      signal,
      catalogPriced: r.catalogPriced,
      active: r.active,
    });
    const out = {
      snapshots: snapshots.rows[0],
      ...summarize([
        ...stampedRows.rows.map(toRow("stamped")),
        ...unstampedRows.rows.map(toRow("unstamped")),
      ]),
    };
    console.log(
      json
        ? JSON.stringify(out)
        : `row 640 census (counts only):\n${JSON.stringify(out, null, 2)}\nLimits:\n- ${LIMITS.join("\n- ")}`,
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
