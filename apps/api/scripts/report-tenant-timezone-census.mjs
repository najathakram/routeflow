/**
 * READ-ONLY census for SA-738 (rule 5): how many tenants have no usable time zone.
 *   (a) tenants with NO TenantConfig row (LEFT JOIN ... c.id IS NULL), and
 *   (b) tenants whose stored zone FAILS the resolver's read-side Intl check (blank, unknown name,
 *       an offset such as "+01:00").
 * Both resolve to UTC today (`apps/api/src/common/tenant-time-zone.ts`). COUNTS ONLY: no slug, name
 * or id is ever printed. Test tenants (scripts/lib/test-tenants.cjs) are counted in their own block.
 *
 * What the numbers mean: a count above zero in (a) leads to an additive backfill that creates
 * default rows. TenantConfig.timezone's column default is America/New_York, so a backfill would move
 * those tenants' money days from UTC to New York. Run a dry run first and get the owner's explicit
 * yes before any backfill. A count above zero in (b) needs a ruling per tenant.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-tenant-timezone-census.mjs [--json]
 *
 * `--self-test` runs the pure counting checks with no database and exits.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query, the one SELECT runs inside
 * BEGIN READ ONLY ... ROLLBACK, `statement_timeout` and `lock_timeout` cap it, the connection is
 * closed in `finally`, and only SELECT appears below.
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
 * The resolver's READ-side predicate (`isValidTimeZone` in apps/api/src/common/tenant-time-zone.ts),
 * restated here because a .mjs script cannot import the TypeScript module. A spec pins the two
 * equal over a sample set, so they cannot drift.
 */
export function isUsableZone(raw) {
  if (typeof raw !== "string" || raw.length === 0 || !/^[A-Za-z]/.test(raw)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return true;
  } catch {
    return false;
  }
}

/** Counts only. `rows` are { slug, hasConfig, timezone }; the slug is read for classification, never kept. */
export function countZones(rows) {
  let noConfigRow = 0;
  let invalidZone = 0;
  for (const r of rows) {
    if (!r.hasConfig) noConfigRow += 1;
    else if (!isUsableZone(r.timezone)) invalidZone += 1;
  }
  return { tenants: rows.length, noConfigRow, invalidZone };
}

/** { live, test } counts: test tenants (policy list) apart from live ones. */
export function summarize(rows) {
  return {
    live: countZones(rows.filter((r) => !isTestTenant(r.slug))),
    test: countZones(rows.filter((r) => isTestTenant(r.slug))),
  };
}

/** No-DB checks of the pure functions (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(
    ["America/Chicago", "UTC", "", null, "Mars/Phobos", "+01:00", 42].map(isUsableZone),
    [true, true, false, false, false, false, false],
    "isUsableZone",
  );
  const s = summarize([
    { slug: "acme", hasConfig: true, timezone: "America/Chicago" },
    { slug: "globex", hasConfig: false, timezone: null },
    { slug: "initech", hasConfig: true, timezone: "Mars/Phobos" },
    { slug: "qa-smoke", hasConfig: false, timezone: null },
  ]);
  eq(s.live, { tenants: 3, noConfigRow: 1, invalidZone: 1 }, "live");
  eq(s.test, { tenants: 1, noConfigRow: 1, invalidZone: 0 }, "test");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl("report-tenant-timezone-census");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("BEGIN READ ONLY");
    let rows;
    try {
      ({ rows } = await client.query(
        `SELECT t.slug, c.id IS NOT NULL AS "hasConfig", c.timezone AS timezone
           FROM "Tenant" t
           LEFT JOIN "TenantConfig" c ON c."tenantId" = t.id
          WHERE t."deletedAt" IS NULL`,
      ));
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
    const report = summarize(rows);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, c] of Object.entries(report)) {
        console.log(`${block}: ${c.tenants} tenant(s)`);
        console.log(`  no TenantConfig row:        ${c.noConfigRow}`);
        console.log(`  stored zone fails Intl:     ${c.invalidZone}`);
      }
      console.log(
        "note: both resolve to UTC today. Backfilling default rows (column default America/New_York)" +
          " would move those tenants' money days UTC -> New York: dry run first, owner's explicit yes.",
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run only when invoked directly: importing this module (for `summarize` / `selfTest`) must never
 * start a report. Paths are compared after realpath, case-insensitively on Windows; when only the
 * file NAMES match it warns and runs anyway, because a silent exit 0 reads as "nothing found".
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
      `report-tenant-timezone-census: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-tenant-timezone-census: ${e.message}`);
    process.exit(1);
  });
}
