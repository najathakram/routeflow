/**
 * READ-ONLY count for #2436 (P0): tenants that have a Stripe customer but NO stored subscription id.
 * Under Stripe API dahlia the subscription period moved onto its items; checkout.session.completed
 * read the old top-level field, wrote `new Date(NaN)`, Prisma rejected it and the webhook 500'd — so
 * `stripeSubId` was never stored (the overdue cron and the double-subscription guard then skip the
 * tenant). This counts the population the fix's backfill/reconciliation will need to cover.
 *
 * The count is an UPPER BOUND: a Stripe customer is created before any payment (at checkout start,
 * or by the billing customer endpoint), so an abandoned checkout also has a customer and no
 * subscription id. Reconcile each candidate against Stripe before acting on it.
 *
 * OWNER-ONLY. Never run from an implementation session or by a lead: the owner runs it via
 * `railway run`, with a per-call approval:
 *
 *   railway run --service postgres node apps/api/scripts/report-b2436-stripe-missing-sub.mjs [--json]
 *
 * `--self-test` runs the pure summary checks with no database and exits.
 *
 * Output is COUNTS ONLY — by tenant status, live vs test (scripts/lib/test-tenants.cjs). No tenant id,
 * slug, name or Stripe id is ever printed.
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

/** Counts per tenant status. Ids and slugs never leave this function. */
export function summarize(rows) {
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return { tenants: rows.length, byStatus };
}

/** No-DB checks of the pure part (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const s = summarize([
    { tenantId: "a", slug: "x", status: "ACTIVE" },
    { tenantId: "b", slug: "y", status: "ACTIVE" },
    { tenantId: "c", slug: "z", status: "TRIAL" },
  ]);
  eq(s, { tenants: 3, byStatus: { ACTIVE: 2, TRIAL: 1 } }, "summarize");
  if (/"[abcxyz]"/.test(JSON.stringify(s))) throw new Error("summary leaked an id or slug");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl("report-b2436-stripe-missing-sub");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");
    const { rows } = await client.query(
      `SELECT s."tenantId", t.slug, t.status::text AS status
         FROM "TenantSubscription" s
         JOIN "Tenant" t ON t.id = s."tenantId"
        WHERE s."stripeCustomerId" IS NOT NULL AND s."stripeSubId" IS NULL
          AND t."deletedAt" IS NULL`,
    );
    const report = {
      live: summarize(rows.filter((r) => !isTestTenant(r.slug))),
      test: summarize(rows.filter((r) => isTestTenant(r.slug))),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, s] of Object.entries(report)) {
        const parts = Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`);
        console.log(
          `${block}: ${s.tenants} tenant(s) with a Stripe customer but no subscription id`,
        );
        if (parts.length) console.log(`  by status: ${parts.join(", ")}`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run only when invoked directly: importing this module (for `summarize` / `selfTest`) must never
 * start a report. Paths are compared after realpath, case-insensitively on Windows; when only the
 * file NAMES match it warns and runs anyway — a silent exit 0 would read as "none found".
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
      `report-b2436-stripe-missing-sub: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-b2436-stripe-missing-sub: ${e.message}`);
    process.exit(1);
  });
}
