// T6 pre-check — READ-ONLY. Counts rows with a NULL "tenantId" in each of the 56 tables the T6
// migrations put a `<table>_tenantId_nn` CHECK on, so the owner knows BEFORE applying whether the
// VALIDATE step would fail. The table list is parsed from the part-1 migration itself, so this
// script can never disagree with what the migration guards.
//
//   railway run --service postgres node apps/api/scripts/t6-null-census.mjs     # prod (owner)
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/t6-null-census.mjs --local
//
// `--guards` instead checks the 56 `<table>_tenantId_nn` constraints exist and are validated (run it after the migration).
// Exit: 0 every table has zero NULL rows (safe to migrate) · 1 at least one table has NULL rows
// (prints table + count; do NOT migrate — the VALIDATE migration would fail) · 2 env/connection error.
// It opens a READ ONLY transaction and only ever runs SELECT count(*).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PART1 = resolve(
  here,
  "../prisma/migrations/20260920220000_t6_tenantid_check_not_valid/migration.sql",
);

/** The tables the part-1 migration guards, read from its own ADD CONSTRAINT lines. */
export function guardedTables(sql) {
  return [...sql.matchAll(/^ALTER TABLE "(\w+)" ADD CONSTRAINT "\1_tenantId_nn"/gm)].map(
    (m) => m[1],
  );
}

async function main() {
  const local = process.argv.includes("--local");
  let url;
  let localCfg = null; // --local: the explicit fields that were vetted are the ones dialled
  try {
    url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (local) {
      localCfg = requireLocalPgConfig(url);
    }
  } catch (e) {
    console.error(`t6-null-census: ${e.message}`);
    return 2;
  }
  const tables = guardedTables(readFileSync(PART1, "utf8"));
  if (tables.length !== 56) {
    console.error(
      `t6-null-census: expected 56 guarded tables in the migration, found ${tables.length}`,
    );
    return 2;
  }
  console.log(`t6-null-census: target ${redactUrl(url)} — ${tables.length} tables`);
  const client = new pg.Client(localCfg ?? { connectionString: url });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    if (process.argv.includes("--guards")) {
      // Post-apply check (still read-only): every one of the 56 guards present and validated.
      const { rows } = await client.query(
        `SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%\\_tenantId\\_nn'`,
      );
      await client.query("ROLLBACK");
      const names = new Set(rows.map((r) => r.conname));
      const missing = tables.filter((t) => !names.has(`${t}_tenantId_nn`));
      const unvalidated = rows.filter((r) => !r.convalidated).map((r) => r.conname);
      console.log(
        `t6-null-census --guards: ${rows.length} guards, ${rows.length - unvalidated.length} validated`,
      );
      if (rows.length === 56 && missing.length === 0 && unvalidated.length === 0) return 0;
      if (missing.length) console.error(`  missing: ${missing.join(", ")}`);
      if (unvalidated.length) console.error(`  NOT VALID: ${unvalidated.join(", ")}`);
      return 1;
    }
    const bad = [];
    for (const t of tables) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM "${t}" WHERE "tenantId" IS NULL`,
      );
      if (rows[0].n > 0) bad.push([t, rows[0].n]);
    }
    await client.query("ROLLBACK");
    if (bad.length === 0) {
      console.log("t6-null-census: OK — 0 NULL tenantId rows in all 56 tables");
      return 0;
    }
    console.error("t6-null-census: NULL tenantId rows found — do NOT migrate:");
    for (const [t, n] of bad) console.error(`  ${t}: ${n}`);
    return 1;
  } catch (e) {
    console.error(`t6-null-census: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

// Import-safe: a spec can load `guardedTables` without running the census.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
