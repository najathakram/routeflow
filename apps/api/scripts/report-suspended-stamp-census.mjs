/**
 * READ-ONLY census: SUSPENDED tenants that never get the 'stripe_cancelled' win-back stamp (counts by class and
 * readOnlyReason). Owner run: railway run --service postgres node apps/api/scripts/report-suspended-stamp-census.mjs --target-host=<host> [--json]
 *
 * Two steps (live-target guard): run once without --target-host to see the resolved host (exit 64), then name it.
 * SAFETY: refuses BEFORE connecting unless --target-host equals the resolved host (64 missing, 65 mismatch);
 * the session is read-only (default_transaction_read_only, BEGIN TRANSACTION READ ONLY, ROLLBACK) with TimeZone UTC;
 * no write flag exists (exit 2). Output is counts only: no tenant id, slug or name is ever selected.
 * It does not call Stripe. Pure logic + SQL: ./lib/report-suspended-stamp-census.cjs
 */
import { createRequire } from "module";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const lib = require("./lib/report-suspended-stamp-census.cjs");
const base = require("./lib/report-839-regulated-void-residue.cjs");
const { refuseRetiredFlags } = require("./lib/live-target-guard.cjs");

const NAME = "report-suspended-stamp-census";

async function main() {
  const argv = process.argv.slice(2);
  try {
    refuseRetiredFlags(argv);
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(2);
  }
  const args = lib.checkArgs(argv);
  if (!args.ok) {
    console.error(`${NAME}: ${args.message}`);
    process.exit(2);
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const target = base.targetOf(databaseUrl);
  console.error(`${NAME}: DB host ${target.host} · database ${target.database}`);
  const guard = base.guardTarget(args.targetHost, target);
  if (!guard.ok) {
    console.error(`${NAME}: ${guard.message}`);
    process.exit(guard.code);
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query(lib.SET_UTC);
    const report = await base.withReadOnlyTx(client, () => lib.buildReport(client));
    const meta = { generatedAt: new Date().toISOString() };
    console.log(
      args.json
        ? JSON.stringify(lib.jsonReport(report, meta), null, 2)
        : lib.formatReport(report, meta),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`${NAME}: ${e.message}`);
  process.exit(1);
});
