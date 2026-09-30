// T6 ROLLBACK — drops the 56 `<table>_tenantId_nn` CHECK constraints. Instant, no data touched.
// The ONLY prod-writing thing in T6 besides the migrations themselves, so it is deliberately
// awkward to run by accident: it does nothing without --yes-drop-t6-guards.
//
//   railway run --service postgres node apps/api/scripts/t6-drop-guards.mjs --yes-drop-t6-guards
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/t6-drop-guards.mjs --local --yes-drop-t6-guards
//
// Exit: 0 dropped (or nothing to drop) · 1 missing --yes-drop-t6-guards · 2 env/connection error.
// All 56 in ONE transaction: it either drops all of them or none.
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

async function main() {
  if (!process.argv.includes("--yes-drop-t6-guards")) {
    console.error("t6-drop-guards: refusing to run without --yes-drop-t6-guards");
    return 1;
  }
  let url;
  let localCfg = null; // --local: the explicit fields that were vetted are the ones dialled
  try {
    url = process.argv.includes("--local")
      ? process.env.DATABASE_URL
      : resolveDatabaseUrl(process.env);
    if (!url) throw new Error("--local requires DATABASE_URL");
    if (process.argv.includes("--local")) {
      localCfg = requireLocalPgConfig(url);
    }
  } catch (e) {
    console.error(`t6-drop-guards: ${e.message}`);
    return 2;
  }
  const tables = [
    ...readFileSync(PART1, "utf8").matchAll(
      /^ALTER TABLE "(\w+)" ADD CONSTRAINT "\1_tenantId_nn"/gm,
    ),
  ].map((m) => m[1]);
  if (tables.length !== 56) {
    console.error(`t6-drop-guards: expected 56 tables in the migration, found ${tables.length}`);
    return 2;
  }
  console.log(`t6-drop-guards: target ${redactUrl(url)}`);
  const client = new pg.Client(localCfg ?? { connectionString: url });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    let dropped = 0;
    for (const t of tables) {
      const r = await client.query(
        `ALTER TABLE "${t}" DROP CONSTRAINT IF EXISTS "${t}_tenantId_nn"`,
      );
      if (r) dropped += 1;
    }
    await client.query("COMMIT");
    console.log(`t6-drop-guards: done — ${dropped} statements run (guards that existed are gone)`);
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`t6-drop-guards: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
