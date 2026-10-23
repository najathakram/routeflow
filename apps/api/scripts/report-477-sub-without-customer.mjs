/**
 * READ-ONLY count for #477: tenants that have a stored Stripe SUBSCRIPTION id but NO Stripe CUSTOMER id
 * (NULL or an empty string - the gate treats both as absent).
 * The admin CANCELLED / delete gate confirms a subscription 404 is not a wrong-key/mode artefact by reading the
 * tenant's Stripe customer; with no customer id stored that check cannot run, so a subscription Stripe does
 * not return can never be told apart from a key/mode mismatch, so the gate refuses it
 * (STRIPE_SUBSCRIPTION_OWNER_MISMATCH, reason NO_STORED_CUSTOMER, no ops alert). A subscription Stripe DOES return
 * is refused the same way: with no stored customer its owner cannot be confirmed, and the subscription's own
 * customer is never adopted as the tenant's.
 * This counts the population the ops path (#477b) applies to, so the owner can see how many tenants it affects.
 *
 * OWNER-ONLY. Never run from an implementation session or by a lead: the owner runs it via
 * `railway run`, with a per-call approval:
 *
 *   railway run --service postgres node apps/api/scripts/report-477-sub-without-customer.mjs [--json] [--detail]
 *
 * `--self-test` runs the pure summary checks with no database and exits.
 *
 * Output is COUNTS ONLY - by tenant status, live vs test (scripts/lib/test-tenants.cjs). No slug, name, email or
 * Stripe id is ever printed. `--detail` adds the TENANT IDS (nothing else) of each block, for the follow-up lookup.
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

const NAME = "report-477-sub-without-customer";

/** Counts per tenant status. Ids and slugs never leave this function. */
export function summarize(rows) {
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return { tenants: rows.length, byStatus };
}

/** Tenant ids only (the opt-in `--detail`). Nothing else about a row is ever returned. */
export function detailIds(rows) {
  return rows.map((r) => r.tenantId);
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
  eq(detailIds([{ tenantId: "a", slug: "x", status: "ACTIVE" }]), ["a"], "detailIds");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const detail = argv.includes("--detail");
  const databaseUrl = resolveReportDbUrl(NAME);
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
        WHERE s."stripeSubId" IS NOT NULL AND (s."stripeCustomerId" IS NULL OR s."stripeCustomerId" = '')
          AND t."deletedAt" IS NULL`,
    );
    const blocks = {
      live: rows.filter((r) => !isTestTenant(r.slug)),
      test: rows.filter((r) => isTestTenant(r.slug)),
    };
    const report = Object.fromEntries(
      Object.entries(blocks).map(([k, v]) => [
        k,
        detail ? { ...summarize(v), tenantIds: detailIds(v) } : summarize(v),
      ]),
    );
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, s] of Object.entries(report)) {
        const parts = Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`);
        console.log(
          `${block}: ${s.tenants} tenant(s) with a Stripe subscription id but no customer id`,
        );
        if (parts.length) console.log(`  by status: ${parts.join(", ")}`);
        if (detail && s.tenantIds.length) console.log(`  tenant ids: ${s.tenantIds.join(", ")}`);
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
      `report-477-sub-without-customer: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-477-sub-without-customer: ${e.message}`);
    process.exit(1);
  });
}
