/**
 * READ-ONLY census for #2187 / SA-387: subscription rows by tenant status, billing-period length
 * and cycle. #2227 prorates a non-ANNUAL row over periodMonths(periodStart, periodEnd) monthly
 * charges, so a 90/180-day manual row (cycle MONTHLY since B863) was under-quoted 3×/6× before it.
 * This counts how many tenants sit in each period-length bucket — the population #2227 changes
 * quotes for.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-b2187-subscription-period-census.mjs [--json]
 *
 * `--self-test` runs the pure bucketing/summary checks with no database and exits.
 *
 * Population: non-deleted tenants in ACTIVE, TRIAL or READ_ONLY whose subscription has both period
 * bounds. Output is a status × bucket × cycle table, a separate cancelAtPeriodEnd count per cell,
 * and anonymous labels ("tenant A", "tenant B", …) for rows outside the "<=35" bucket — no tenant
 * id, slug or name is printed. A period whose end precedes its start is counted as "invalid", never
 * as "<=35". Test tenants (scripts/lib/test-tenants.cjs) are counted in a separate `test` block.
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

/** Tenant statuses counted, in report order. */
export const STATUSES = ["ACTIVE", "TRIAL", "READ_ONLY"];

/** Period-length buckets in days (inclusive upper bounds), in report order. */
export const BUCKETS = [
  { label: "<=35", max: 35 },
  { label: "36-45", max: 45 },
  { label: "46-75", max: 75 },
  { label: "76-135", max: 135 },
  { label: "136-225", max: 225 },
  { label: ">225", max: Infinity },
];

/** The bucket label for a period of `days` days; a negative or non-finite period is "invalid". */
export function bucketOf(days) {
  if (!Number.isFinite(days) || days < 0) return "invalid";
  return BUCKETS.find((b) => days <= b.max).label;
}

const BUCKET_LABELS = [...BUCKETS.map((b) => b.label), "invalid"];

/**
 * counts[status][bucket][cycle] and cancelAtPeriodEnd[status][bucket][cycle], plus anonymous
 * labels (A, B, …, in tenantId order) for rows outside "<=35". Ids and slugs never leave here.
 */
export function summarize(rows) {
  const grid = () =>
    Object.fromEntries(
      STATUSES.map((s) => [s, Object.fromEntries(BUCKET_LABELS.map((b) => [b, {}]))]),
    );
  const counts = grid();
  const cancelAtPeriodEnd = grid();
  const labels = new Map();
  const outside = [];
  for (const r of [...rows].sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1))) {
    const bucket = bucketOf(Number(r.days));
    const cell = counts[r.status]?.[bucket];
    if (!cell) continue; // a status outside STATUSES never reaches the query; defensive only
    cell[r.cycle] = (cell[r.cycle] ?? 0) + 1;
    if (r.cancelAtPeriodEnd) {
      const c = cancelAtPeriodEnd[r.status][bucket];
      c[r.cycle] = (c[r.cycle] ?? 0) + 1;
    }
    if (bucket !== "<=35") {
      if (!labels.has(r.tenantId)) labels.set(r.tenantId, `tenant ${tenantLabel(labels.size)}`);
      outside.push({ tenant: labels.get(r.tenantId), status: r.status, bucket, cycle: r.cycle });
    }
  }
  return { rows: rows.length, counts, cancelAtPeriodEnd, outside };
}

function tenantLabel(i) {
  return String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : "");
}

/** No-DB checks of the pure functions (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(
    [35, 36, 45, 46, 225, 226, -1].map(bucketOf),
    ["<=35", "36-45", "36-45", "46-75", "136-225", ">225", "invalid"],
    "bucketOf",
  );
  const s = summarize([
    {
      tenantId: "b",
      slug: "x",
      status: "TRIAL",
      cycle: "MONTHLY",
      days: 90,
      cancelAtPeriodEnd: true,
    },
    {
      tenantId: "a",
      slug: "y",
      status: "ACTIVE",
      cycle: "MONTHLY",
      days: -3,
      cancelAtPeriodEnd: false,
    },
  ]);
  eq(s.counts.TRIAL["76-135"], { MONTHLY: 1 }, "TRIAL 76-135");
  eq(s.cancelAtPeriodEnd.TRIAL["76-135"], { MONTHLY: 1 }, "cancelAtPeriodEnd");
  eq(s.counts.ACTIVE.invalid, { MONTHLY: 1 }, "invalid bucket");
  eq(
    s.outside.map((o) => o.tenant),
    ["tenant A", "tenant B"],
    "labels",
  );
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl("report-b2187-subscription-period-census");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");
    const { rows } = await client.query(
      `SELECT s."tenantId", t.slug, t.status::text AS status, s.cycle::text AS cycle,
              s."cancelAtPeriodEnd" AS "cancelAtPeriodEnd",
              EXTRACT(EPOCH FROM (s."periodEnd" - s."periodStart")) / 86400.0 AS days
         FROM "TenantSubscription" s
         JOIN "Tenant" t ON t.id = s."tenantId"
        WHERE t.status::text = ANY($1::text[]) AND t."deletedAt" IS NULL
          AND s."periodStart" IS NOT NULL AND s."periodEnd" IS NOT NULL`,
      [STATUSES],
    );
    const report = {
      live: summarize(rows.filter((r) => !isTestTenant(r.slug))),
      test: summarize(rows.filter((r) => isTestTenant(r.slug))),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, s] of Object.entries(report)) {
        console.log(`${block}: ${s.rows} subscription row(s)`);
        for (const st of STATUSES) {
          console.log(`  ${st}`);
          for (const b of BUCKET_LABELS) {
            const fmt = (cell) =>
              Object.entries(cell)
                .map(([c, n]) => `${c} ${n}`)
                .join(", ") || "0";
            const cape = fmt(s.cancelAtPeriodEnd[st][b]);
            console.log(
              `    ${b.padEnd(8)} ${fmt(s.counts[st][b])}${cape === "0" ? "" : `  (cancelAtPeriodEnd: ${cape})`}`,
            );
          }
        }
        for (const o of s.outside)
          console.log(`  ${o.tenant}  ${o.status}  ${o.bucket} days  ${o.cycle}`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
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
      `report-b2187-subscription-period-census: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-b2187-subscription-period-census: ${e.message}`);
    process.exit(1);
  });
}
