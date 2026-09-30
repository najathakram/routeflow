/**
 * rls-preflight.mjs — READ-ONLY RLS-arming pre-flight.
 *
 * Before the `20260909000000_rls` migration is applied to production, every
 * table it defines a `tenant_isolation` policy for must have zero rows with a
 * NULL "tenantId". A NULL never equals the session's
 * current_setting('app.current_tenant_id', true), so once
 * `ALTER TABLE ... FORCE ROW LEVEL SECURITY` is armed, a NULL-tenantId row
 * stops being visible or writable to every role — including the app's own
 * connection — not just to other tenants.
 *
 * The table list is parsed straight out of the migration file itself (the
 * `tables := ARRAY[...]` literal in its policy loop) — i.e. out of the exact
 * file `prisma migrate deploy` executes — so it cannot drift from what the
 * migration actually arms policies on. apps/api/prisma/rls.sql, which used to
 * hold a second copy of that list, is now a pointer stub; do not read the
 * table list from anywhere but the migration.
 *
 * SAFE TO RUN AGAINST PRODUCTION:
 *   • The session sets `default_transaction_read_only = on` BEFORE any check
 *     runs, so the server itself rejects any write that might slip in.
 *   • Every query is a bare SELECT count(*); a statement_timeout caps each one.
 *   • This never applies the migration — counting only.
 *
 * Usage:
 *   railway run --service postgres node scripts/rls-preflight.mjs
 *   node scripts/rls-preflight.mjs                 # uses $DATABASE_URL
 *
 * Connection: DATABASE_URL from the environment; when run via `railway run
 * --service postgres` (which injects an internal-only DATABASE_URL) the public
 * TCP proxy URL is assembled from the injected POSTGRES_* / RAILWAY_TCP_PROXY_*
 * variables instead, mirroring scripts/data-integrity-report.mjs.
 *
 * Exit code: non-zero when any policied table has NULL-tenantId rows, when a
 * per-table check errors (e.g. the table is missing the tenantId column
 * entirely — the migration would silently swallow that failure too), or when the
 * run itself fails. Zero only when every policied table is clean to arm.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The migration that actually arms the policies — the single authoritative
// copy of the policied-table list.
const RLS_MIGRATION_PATH = path.join(
  __dirname,
  "..",
  "apps",
  "api",
  "prisma",
  "deferred-rls",
  "20260909000000_rls",
  "migration.sql",
);

// ─── Connection resolution (mirrors scripts/data-integrity-report.mjs) ────────
function resolveUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && !direct.includes(".railway.internal")) return direct;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (RAILWAY_TCP_PROXY_DOMAIN && POSTGRES_USER && POSTGRES_PASSWORD) {
    const db = POSTGRES_DB || "railway";
    const port = RAILWAY_TCP_PROXY_PORT || "5432";
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(
      POSTGRES_PASSWORD,
    )}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

// ─── Table list: parsed from the migration, never hand-duplicated ─────────────
export function loadPoliciedTables() {
  let src;
  try {
    src = fs.readFileSync(RLS_MIGRATION_PATH, "utf8");
  } catch (err) {
    console.error(`Could not read ${RLS_MIGRATION_PATH}: ${err.message}`);
    process.exit(2);
  }
  const arrayMatch = src.match(/tables\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]\s*;/);
  if (!arrayMatch) {
    console.error(`Could not find the "tables := ARRAY[...]" literal in ${RLS_MIGRATION_PATH}`);
    process.exit(2);
  }
  const tables = [...arrayMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (!tables.length) {
    console.error(
      `Parsed zero table names out of ${RLS_MIGRATION_PATH} — the regex drifted from the file`,
    );
    process.exit(2);
  }
  return tables;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * The pre-flight itself, decoupled from pg so it is provable without a database.
 * `query` has pg's `client.query(sql)` shape and is the ONLY way this reaches a
 * server — every statement it issues is the bare SELECT below.
 *
 * Returns `exitCode` non-zero when ANY policied table has NULL-"tenantId" rows or
 * could not be checked at all: a table missing the tenantId column errors here,
 * and the migration would swallow that same failure as a NOTICE, so "could not
 * check" has to block arming exactly like "dirty".
 */
export async function countNullTenantRows(query, tables) {
  const results = [];
  let blocking = 0;
  let errored = 0;

  for (const t of tables) {
    try {
      const res = await query(`SELECT count(*)::int AS n FROM "${t}" WHERE "tenantId" IS NULL`);
      const n = res.rows[0].n;
      results.push({ table: t, count: n });
      if (n > 0) blocking += 1;
    } catch (err) {
      results.push({ table: t, count: "ERR", note: err.message.split("\n")[0] });
      errored += 1;
    }
  }

  return { results, blocking, errored, exitCode: blocking > 0 || errored > 0 ? 1 : 0 };
}

/** The per-table report, as printed. Every blocking table is named in it. */
export function formatReport(results) {
  const lines = [pad("TABLE", 32) + pad("NULL-tenantId ROWS", 20) + "NOTE", "-".repeat(90)];
  for (const r of results) {
    const flag = typeof r.count === "number" && r.count > 0 ? " <<< BLOCKS ARMING" : "";
    const note = r.note ? `[${r.note}] ` : "";
    lines.push(
      pad(r.table, 32) +
        pad(r.count, 20) +
        note +
        (r.count === "ERR" ? "<<< BLOCKS ARMING" : "") +
        flag,
    );
  }
  return lines.join("\n");
}

async function main() {
  const tables = loadPoliciedTables();

  const url = resolveUrl();
  if (!url) {
    console.error(
      "No usable connection string. Set DATABASE_URL, or run via:\n" +
        "  railway run --service postgres node scripts/rls-preflight.mjs",
    );
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  // Hard read-only guarantee + query cap, before anything else runs.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '60s'");

  console.log(`\n=== RLS ARMING PRE-FLIGHT (read-only) — ${tables.length} policied tables ===`);
  console.log(`    ${new Date().toISOString()}\n`);

  const { results, blocking, errored } = await countNullTenantRows(
    (sql) => client.query(sql),
    tables,
  );

  console.log(formatReport(results));

  console.log(
    `\n=== DONE — ${tables.length} tables checked, ${blocking} with NULL-tenantId rows, ` +
      `${errored} errored ===\n`,
  );

  if (blocking > 0 || errored > 0) {
    console.error(
      `RLS pre-flight FAILED: ${blocking} table(s) have rows with a NULL "tenantId"` +
        `${errored ? `, ${errored} table(s) could not even be checked` : ""}.\n` +
        `Resolve those rows (or the underlying schema issue) or get an explicit owner\n` +
        `waiver before arming RLS — a NULL tenantId never matches the session's\n` +
        `current_setting, so once FORCE ROW LEVEL SECURITY is on, those rows become\n` +
        `invisible and unwritable to every role, including the app's own connection.`,
    );
  }

  await client.end();
  process.exitCode = blocking > 0 || errored > 0 ? 1 : 0;
}

// Only connect when this file is the process entry point — importing it (the
// spec does, to drive `countNullTenantRows` against a fake query fn) must never
// open a database connection.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("RLS pre-flight failed to run:", err.message);
    process.exitCode = 2;
  });
}
