/**
 * READ-ONLY usage report for the account-admin endpoints that are about to become TENANT_ADMIN-only
 * (operator permissions PR1, owner ruling 2026-10-07).
 *
 * For each tenant it counts the AuditLog rows, in the last N days (default 90), of an OPERATOR calling
 * one of the closing endpoints, so the owner can see who would lose what BEFORE PR1 merges. Counts
 * only: no request bodies, no names, no ids. Rows written under platform impersonation are excluded
 * (those act as the tenant admin, so they would not be affected).
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   railway run --service postgres node apps/api/scripts/report-operator-account-blast-radius.mjs
 *   railway run --service postgres node apps/api/scripts/report-operator-account-blast-radius.mjs --days 180 --json
 *
 * Only mutations are audited, so the closed READ endpoints (SMTP and AI-key reads, the billing export,
 * import list reads) cannot be counted; the report names them at the end.
 *
 * SAFETY (this script must never be able to touch a client database):
 *   - `default_transaction_read_only = on` is set on the session before any other query runs.
 *   - `statement_timeout` caps every query.
 *   - Only SELECT queries appear below; the connection is closed in `finally`.
 *   - Tenant slugs land in the owner's terminal only, never in the repo.
 */
import { createRequire } from "module";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { CLOSED_MUTATIONS, READS_NOT_COUNTED } = require("./lib/operator-account-routes.cjs");

function parseArgs(argv) {
  let days = 90;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") days = Number(argv[++i]);
    else if (arg.startsWith("--days=")) days = Number(arg.slice("--days=".length));
    else if (arg === "--json") json = true;
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    console.error("--days must be a whole number from 1 to 3650");
    process.exit(2);
  }
  return { days, json };
}

const { days, json } = parseArgs(process.argv.slice(2));

// Fail closed BEFORE any connection is attempted (B768: Railway TCP-proxy variables win over
// DATABASE_URL). The redacted target goes to stderr so --json stdout stays clean.
const databaseUrl = resolveReportDbUrl("report-operator-account-blast-radius");
if (!databaseUrl) process.exit(2);

const client = new Client({ connectionString: databaseUrl });
const q = async (sql, params) => (await client.query(sql, params)).rows;

async function main() {
  await client.connect();
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '45s'");

  // One row per (tenant, group, role) with how many calls and how many distinct people made them.
  const rows = await q(
    `SELECT t.slug,
            r.grp AS "group",
            COALESCE(u.role::text, 'UNKNOWN') AS role,
            COUNT(*)::int AS calls,
            COUNT(DISTINCT a."userId")::int AS people,
            MAX(a."createdAt") AS "lastAt"
       FROM "AuditLog" a
       JOIN "Tenant" t ON t.id = a."tenantId"
       LEFT JOIN "User" u ON u.id = a."userId"
       JOIN (SELECT * FROM unnest($1::text[], $2::text[], $3::boolean[]) AS x(grp, re, not_self)) r
         ON a.action ~ r.re AND (NOT r.not_self OR a."userId" IS DISTINCT FROM a."entityId")
      WHERE a."createdAt" >= now() - make_interval(days => $4)
        AND a."tenantId" IS NOT NULL
        AND a."impersonatedBy" IS NULL
      GROUP BY t.slug, r.grp, u.role
      ORDER BY t.slug, r.grp`,
    [
      CLOSED_MUTATIONS.map((c) => c.group),
      CLOSED_MUTATIONS.map((c) => c.re),
      CLOSED_MUTATIONS.map((c) => Boolean(c.notSelf)),
      days,
    ],
  );

  const operatorRows = rows.filter((r) => r.role === "OPERATOR");
  const tenantsAffected = new Set(operatorRows.map((r) => r.slug));
  const byGroup = {};
  for (const r of operatorRows) {
    byGroup[r.group] ??= { calls: 0, tenants: new Set() };
    byGroup[r.group].calls += r.calls;
    byGroup[r.group].tenants.add(r.slug);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          days,
          rows,
          operatorCallsByGroup: Object.fromEntries(
            Object.entries(byGroup).map(([g, v]) => [
              g,
              { calls: v.calls, tenants: v.tenants.size },
            ]),
          ),
          tenantsWithOperatorCalls: tenantsAffected.size,
          readsNotCounted: READS_NOT_COUNTED,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n=== OPERATOR ACCOUNT-ADMIN USAGE, last ${days} days ===`);
  console.log("    session is READ ONLY; counts only, impersonated sessions excluded\n");
  console.log("Operator calls that would be refused after PR1, by tenant and area:");
  console.table(
    operatorRows.map((r) => ({
      tenant: r.slug,
      area: r.group,
      calls: r.calls,
      people: r.people,
      lastAt: r.lastAt,
    })),
  );
  console.log("\nBy area (operators only):");
  console.table(
    Object.entries(byGroup).map(([area, v]) => ({
      area,
      calls: v.calls,
      tenants: v.tenants.size,
    })),
  );
  console.log(
    `\n${tenantsAffected.size} tenant(s) had at least one operator call in an area PR1 closes.\n` +
      "Calls made by tenant admins are unaffected and not listed.\n",
  );
  console.log("Not countable (reads leave no audit row):");
  for (const line of READS_NOT_COUNTED) console.log(`  - ${line}`);
  console.log("\n=== END — session was read-only; nothing was modified ===\n");
}

main()
  .catch((e) => {
    console.error("operator account usage report failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
