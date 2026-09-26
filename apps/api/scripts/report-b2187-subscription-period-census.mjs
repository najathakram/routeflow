/**
 * READ-ONLY census for #2187 / SA-387: active subscription rows by billing-period length and cycle.
 * #2227 prorates a non-ANNUAL row over periodMonths(periodStart, periodEnd) monthly charges, so a
 * 90/180-day manual row (cycle MONTHLY since B863) was under-quoted 3×/6× before it. This counts how
 * many live tenants sit in each period-length bucket — the population #2227 changes quotes for.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-b2187-subscription-period-census.mjs [--json]
 *
 * "Active" = the tenant is ACTIVE, not deleted, and its subscription has both period bounds.
 * Output is COUNTS ONLY plus anonymous labels ("tenant A", "tenant B", …) for rows outside the
 * ≤ 35-day bucket: no tenant id, slug or name is printed. Test tenants
 * (scripts/lib/test-tenants.cjs) are counted in a separate `test` block.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` caps
 * every query; the connection is closed in `finally`; only SELECT appears below.
 */
import { createRequire } from "module";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

/** Period-length buckets in days (inclusive upper bounds), in report order. */
export const BUCKETS = [
  { label: "<=35", max: 35 },
  { label: "36-45", max: 45 },
  { label: "46-75", max: 75 },
  { label: "76-135", max: 135 },
  { label: "136-225", max: 225 },
  { label: ">225", max: Infinity },
];

/** The bucket label for a period of `days` days. */
export function bucketOf(days) {
  return BUCKETS.find((b) => days <= b.max).label;
}

/**
 * Counts per bucket × cycle, plus anonymous labels (A, B, …) for rows outside "<=35", in tenantId
 * order. Ids and slugs never leave this function.
 */
export function summarize(rows) {
  const counts = {};
  for (const b of BUCKETS) counts[b.label] = {};
  const labels = new Map();
  const outside = [];
  for (const r of [...rows].sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1))) {
    const bucket = bucketOf(Number(r.days));
    counts[bucket][r.cycle] = (counts[bucket][r.cycle] ?? 0) + 1;
    if (bucket !== "<=35") {
      if (!labels.has(r.tenantId)) labels.set(r.tenantId, `tenant ${tenantLabel(labels.size)}`);
      outside.push({ tenant: labels.get(r.tenantId), bucket, cycle: r.cycle });
    }
  }
  return { tenants: rows.length, counts, outside };
}

function tenantLabel(i) {
  return String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : "");
}

async function main() {
  const json = process.argv.slice(2).includes("--json");
  const databaseUrl = resolveReportDbUrl("report-b2187-subscription-period-census");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    const { rows } = await client.query(
      `SELECT s."tenantId", t.slug, s.cycle::text AS cycle,
              EXTRACT(EPOCH FROM (s."periodEnd" - s."periodStart")) / 86400.0 AS days
         FROM "TenantSubscription" s
         JOIN "Tenant" t ON t.id = s."tenantId"
        WHERE t.status = 'ACTIVE' AND t."deletedAt" IS NULL
          AND s."periodStart" IS NOT NULL AND s."periodEnd" IS NOT NULL`,
    );
    const report = {
      live: summarize(rows.filter((r) => !isTestTenant(r.slug))),
      test: summarize(rows.filter((r) => isTestTenant(r.slug))),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, s] of Object.entries(report)) {
        console.log(`${block}: ${s.tenants} active subscription row(s)`);
        for (const b of BUCKETS) {
          const byCycle = Object.entries(s.counts[b.label]).map(([c, n]) => `${c} ${n}`);
          console.log(`  ${b.label.padEnd(8)} ${byCycle.join(", ") || "0"}`);
        }
        for (const o of s.outside) console.log(`  ${o.tenant}  ${o.bucket} days  ${o.cycle}`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`report-b2187-subscription-period-census: ${e.message}`);
    process.exit(1);
  });
}
