/**
 * READ-ONLY precondition for the `rf_invoice_manual_lifecycle` migration (manual invoices due, PR1):
 * "RfInvoice has 0 rows". The migration's non-concurrent index builds are waived with exactly that
 * reason ("RfInvoice has no writer before this migration"), so the owner proves it before applying.
 *
 * Exit 0 ONLY when the count is exactly 0. Any row (1), an unreadable count or an error (1), and a
 * missing database url (2) are all non-zero. Output is the COUNT only - no id, number or tenant.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-rf-invoice-zero-rows.mjs
 *
 * `--self-test` runs the pure check with no database and exits.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and
 * `lock_timeout` cap every query; the connection is closed in `finally`; only a SELECT appears below.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);

/** The process exit code for a counted number of RfInvoice rows: 0 only for exactly zero. */
export function exitCodeForCount(count) {
  return count === 0 ? 0 : 1;
}

/** No-DB checks of the pure part (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const cases = [
    [0, 0],
    [1, 1],
    [41, 1],
    [-1, 1],
    [null, 1],
    [undefined, 1],
    ["0", 1],
  ];
  for (const [count, want] of cases) {
    if (exitCodeForCount(count) !== want)
      throw new Error(`exitCodeForCount(${JSON.stringify(count)}) !== ${want}`);
  }
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const databaseUrl = resolveReportDbUrl("report-rf-invoice-zero-rows");
  if (!databaseUrl) process.exit(2);
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '30s'");
    await client.query("SET lock_timeout = '5s'");
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM "RfInvoice"');
    const count = rows[0]?.n;
    console.log(`RfInvoice rows: ${count}`);
    const code = exitCodeForCount(count);
    console.log(code === 0 ? "OK: 0 rows - the migration may be applied." : "STOP: not empty.");
    process.exitCode = code;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run only when invoked directly: importing this module (for `exitCodeForCount`) must never start a
 * report. Paths are compared after realpath; when only the file NAMES match it warns and runs anyway,
 * because a silent exit 0 reads as "0 rows".
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
      `report-rf-invoice-zero-rows: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-rf-invoice-zero-rows: ${e.message}`);
    process.exit(1);
  });
}
