/**
 * READ-ONLY report for SA-693 (owner ruling 2026-10-05 "Mark grants as comps"): which existing
 * TenantAddon rows are probably platform GRANTS that should be stamped `isComp = true`.
 *
 * Candidates are ACTIVE, item-less (stripeItemId NULL), $0 (priceSnapshot 0 or NULL), not yet comp
 * rows of a SELF-SERVE SKU. Each is classified by who enabled it:
 *   - SUPER_ADMIN  -> "grant-candidate"  (a platform operator switched it on: a comp in all but name)
 *   - any tenant role (TENANT_ADMIN, ...) -> "self-serve" (the tenant did it: NOT a comp; the SA-690
 *     checkout gate rightly blocks it until it is billed or turned off)
 *   - no trace -> "unknown"
 * The enabling actor comes from the latest `addon.enabled` BillingEvent (actorId) for that tenant+SKU.
 * A $0 enable books a zero delta and `emitAddonDelta` writes NO event for it, so most $0 rows have none:
 * the fallback is the latest `ADDON_ENABLED` AuditLog row for the tenant+add-on (userId), which the
 * platform-admin enable route always writes. `via` says which source answered.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-addon-comp-candidates.mjs [--json]
 *
 * Output is tenant UUIDs, row ids and COUNTS only: no tenant name, slug or user id is printed. Test
 * tenants (scripts/lib/test-tenants.cjs) are tagged TEST; everything else LIVE. Feed the
 * grant-candidate row ids you decide on to stamp-addon-comp.mjs (dry-run first).
 *
 * `--self-test` runs the pure checks with no database and exits.
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
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

/**
 * Mirror of SELF_SERVICE_ADDON_SKUS (apps/api/src/billing/plan-catalog.constants.ts). A .mjs cannot
 * import the TS list; report-addon-comp-candidates-script.spec.ts pins the two deep-equal.
 */
export const SELF_SERVICE_ADDON_SKUS = ["CUSTOMER_PACK_100", "FORECASTING"];

/** Mirror of LEGACY_ADDON_KEY_TO_SKU (same pin as above): an AuditLog's `addonKey` may be a legacy key. */
export const LEGACY_ADDON_KEY_TO_SKU = {
  tobacco_dealer: "REGULATED_ITEMS",
  msrp: "MSRP",
  sales_agents: "SALES_AGENTS",
  ocr: "OCR_PACK_250",
};

/** Role of the enabling actor -> the report's verdict. */
export function classify(role) {
  if (role == null) return "unknown";
  return role === "SUPER_ADMIN" ? "grant-candidate" : "self-serve";
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(classify("SUPER_ADMIN"), "grant-candidate", "super admin");
  eq(classify("TENANT_ADMIN"), "self-serve", "tenant admin");
  eq(classify(null), "unknown", "no trace");
  const s = summarize([
    {
      id: "r1",
      tenantId: "t1",
      slug: "x",
      sku: "FORECASTING",
      quantity: 1,
      role: "SUPER_ADMIN",
      via: "audit-log",
    },
    {
      id: "r2",
      tenantId: "t1",
      slug: "x",
      sku: "CUSTOMER_PACK_100",
      quantity: 2,
      role: "TENANT_ADMIN",
      via: "billing-event",
    },
    {
      id: "r3",
      tenantId: "t2",
      slug: "y",
      sku: "FORECASTING",
      quantity: 1,
      role: null,
      via: "none",
    },
  ]);
  eq(s.total, 3, "total");
  eq(s.counts, { "grant-candidate": 1, "self-serve": 1, unknown: 1 }, "counts");
  eq(s.tenants, 2, "tenants");
  if (JSON.stringify(s).includes('"x"') || JSON.stringify(s).includes('"y"'))
    throw new Error("summary leaked a slug");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl("report-addon-comp-candidates");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");

    const legacyKeys = Object.keys(LEGACY_ADDON_KEY_TO_SKU);
    const legacySkus = legacyKeys.map((k) => LEGACY_ADDON_KEY_TO_SKU[k]);
    const { rows } = await client.query(
      `WITH legacy AS (SELECT * FROM unnest($1::text[], $2::text[]) AS m(key, sku)),
            cand AS (
              SELECT a.id, a."tenantId", t.slug, a.quantity,
                     COALESCE(a.sku, l.sku, a."addonKey") AS code, a."addonKey"
                FROM "TenantAddon" a
                JOIN "Tenant" t ON t.id = a."tenantId"
                LEFT JOIN legacy l ON l.key = a."addonKey"
               WHERE a.active = true
                 AND a."stripeItemId" IS NULL
                 AND COALESCE(a."priceSnapshot", 0) = 0
                 AND a."isComp" = false
                 AND COALESCE(a.sku, l.sku, a."addonKey") = ANY($3::text[]))
       SELECT c.id, c."tenantId", c.slug, c.code AS sku, c.quantity,
              COALESCE(be.role, al.role) AS role,
              CASE WHEN be.role IS NOT NULL THEN 'billing-event'
                   WHEN al.role IS NOT NULL THEN 'audit-log' ELSE 'none' END AS via
         FROM cand c
         LEFT JOIN LATERAL (
              SELECT u.role::text AS role
                FROM "BillingEvent" e JOIN "User" u ON u.id = e."actorId"
               WHERE e."tenantId" = c."tenantId" AND e.type = 'addon.enabled'
                 AND e.payload->>'sku' = c.code
               ORDER BY e."createdAt" DESC LIMIT 1) be ON true
         LEFT JOIN LATERAL (
              SELECT u.role::text AS role
                FROM "AuditLog" g JOIN "User" u ON u.id = g."userId"
               WHERE g."tenantId" = c."tenantId" AND g.action = 'ADDON_ENABLED'
                 AND (g.meta->>'addonKey' = c.code OR g.meta->>'addonKey' = c."addonKey")
               ORDER BY g."createdAt" DESC LIMIT 1) al ON true
        ORDER BY c."tenantId", c.code, c.id`,
      [legacyKeys, legacySkus, SELF_SERVICE_ADDON_SKUS],
    );

    const report = {
      live: summarize(rows.filter((r) => !isTestTenant(r.slug))),
      test: summarize(rows.filter((r) => isTestTenant(r.slug))),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, s] of Object.entries(report)) {
        console.log(
          `${block.toUpperCase()}: ${s.total} row(s) across ${s.tenants} tenant(s) — ` +
            `grant-candidate ${s.counts["grant-candidate"]}, self-serve ${s.counts["self-serve"]}, unknown ${s.counts.unknown}`,
        );
        for (const d of s.detail)
          console.log(
            `  ${d.id}  tenant ${d.tenantId}  ${d.sku}  qty ${d.quantity}  ${d.verdict}  via ${d.via}`,
          );
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Counts + one detail line per row. Ids and UUIDs only; the slug is used by the caller to split LIVE/TEST and never kept. */
export function summarize(rows) {
  const counts = { "grant-candidate": 0, "self-serve": 0, unknown: 0 };
  const detail = rows.map((r) => {
    const verdict = classify(r.role);
    counts[verdict] += 1;
    return {
      id: r.id,
      tenantId: r.tenantId,
      sku: r.sku,
      quantity: r.quantity,
      verdict,
      via: r.via,
    };
  });
  return { total: rows.length, tenants: new Set(rows.map((r) => r.tenantId)).size, counts, detail };
}

/**
 * Run only when invoked directly: importing this module (for `summarize` / `selfTest`) must never
 * start a report. Paths are compared after realpath, case-insensitively on Windows; when only the
 * file NAMES match it warns and runs anyway, because a silent exit 0 reads as "nothing found"
 * (the report-b673 pattern).
 */
export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      // keep the path as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  if (norm(entry) === norm(self)) return true;
  if (basename(entry).toLowerCase() === basename(self).toLowerCase()) {
    console.error(
      `report-addon-comp-candidates: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-addon-comp-candidates: ${e.message}`);
    process.exit(1);
  });
}
