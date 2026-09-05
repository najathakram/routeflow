#!/usr/bin/env node
/**
 * Dry-run-first repair for legacy rows whose `tenantId` IS NULL.
 *
 * WHY THIS EXISTS. 81 of 125 models declare `tenantId String?` and were never backfilled, so a
 * handful of rows predate multi-tenancy with a NULL tenant. Such a row is invisible to every
 * tenant-scoped read AND to the fail-closed tenancy post-filter (a NULL tenant reads as
 * "foreign"), which makes it unfixable through the product:
 *   - a NULL `RouteRunStop` still renders on the run card through a nested include, but cannot
 *     be completed or skipped — the run auto-completes with the stop stuck PENDING;
 *   - a NULL `PaymentCounter` has no read path at all;
 *   - a NULL `CreditNote` was already invisible everywhere.
 * The tenancy guard stays fail-closed; the rows are the defect, so they get repaired as DATA.
 * Counts on production, 2026-09-05: RouteRunStop 5, PaymentCounter 1, CreditNote 1.
 *
 * MODES
 *   (default)     report — read-only. Lists every NULL-tenant row with its parents, the tenant
 *                 this tool would derive, and a verdict. Exit 0.
 *   --dry-run     report + the exact parameterized UPDATE statements `--live` would run, with
 *                 their bound values. Still read-only. Exit 0.
 *   --live        report + typed confirmation, then ONE transaction of id-pinned UPDATEs.
 *                 Requires `--backup-attested "<free text naming the fresh backup>"`.
 *   --json        print the report as JSON instead of prose (for the owner's records).
 *   --help        usage, exit 0.
 *
 * EXIT CODES
 *   0  report / dry-run printed, or `--live` applied every ok row
 *   1  error — no database URL, connection or query failure, transaction error
 *   2  argument refusal, raised BEFORE any connection is opened (notably `--live` with no
 *      `--backup-attested`)
 *   3  `--live` confirmation refused — stdin is not a TTY, or the typed text did not match
 *   4  `--live` rolled back — a row changed under us (its guarded UPDATE returned no row)
 *
 * PRODUCTION-SAFETY RULES (this is a data repair on a live database, not a schema change)
 *   - Take a FRESH backup first, and name it in `--backup-attested`. The tool cannot verify it;
 *     the attestation exists so the owner has to state it out loud.
 *   - Run report, then `--dry-run`, then `--live` — in that order, reading the output each time.
 *   - OWNER-RUN ONLY. Never run this from an implementation session, and never against a
 *     database you have not just read the target line for:
 *       railway run --service postgres node apps/api/scripts/backfill-legacy-tenant-ids.mjs
 *   - This is NEVER a migration. It touches rows, never the datamodel; nothing here belongs in
 *     `apps/api/prisma/migrations/**`, and a re-run after a partial repair is safe because every
 *     statement still carries `AND "tenantId" IS NULL`.
 *   - Refusals are left alone on purpose. A refused row is a decision for the owner, not for a
 *     script — re-run the report after the underlying data is fixed.
 *   - Report/`--dry-run` set `default_transaction_read_only = on` for the whole session, so the
 *     server itself rejects a write; `--live` lifts it only after the confirmation, and says so.
 *   - Output discipline: ids, tenant ids, credit-note numbers and enum statuses only. Never a
 *     business name, an email, an amount, `PaymentCounter.next`, or the connection URL.
 */
import { createRequire } from "node:module";
import readline from "node:readline";
import { resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import {
  buildUpdates,
  classifyCreditNote,
  classifyPaymentCounter,
  classifyRouteRunStop,
  VERDICT_OK,
} from "./lib/legacy-tenant-backfill.mjs";

const HELP = `backfill-legacy-tenant-ids.mjs — repair rows whose tenantId IS NULL

Usage: node apps/api/scripts/backfill-legacy-tenant-ids.mjs [--dry-run | --live] [--json]
                                                            [--backup-attested "<text>"]

Modes:
  (none)      read-only report: every NULL-tenant row, its parents, the derived tenant, a verdict
  --dry-run   the report plus the exact UPDATE statements --live would execute (still read-only)
  --live      apply them in one transaction; requires --backup-attested AND a typed confirmation
  --json      print the report as JSON instead of prose
  --help      print this help and exit 0

Tables: RouteRunStop, PaymentCounter, CreditNote.

Verdicts:
  ok                            tenant derived unambiguously from the parent row(s)
  refuse: parent missing        a parent row is absent or its own tenantId is NULL
  refuse: parents disagree      the parents name different tenants
  refuse: singleton             PaymentCounter id is the literal "singleton", or matches no Tenant
  refuse: unique-pair collision another CreditNote already holds (tenantId, creditNoteNumber)

DATABASE_URL resolution (Railway proxy vars win over DATABASE_URL) — see lib/railway-db-url.mjs.

Exit codes: 0 ok · 1 error · 2 argument refusal (before connecting) · 3 confirmation refused
            · 4 rolled back (a row changed under us)
`;

// ─── arguments ────────────────────────────────────────────────────────────────────────────────
// Parsed and validated BEFORE anything else runs: no URL is resolved, no driver is loaded and no
// connection is opened until the flags are known to be coherent. `--live` with no attested backup
// must be able to fail on a machine with no database at all.

function parseArgs(argv) {
  const opts = {
    help: false,
    dryRun: false,
    live: false,
    json: false,
    backupAttested: null,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--live") opts.live = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--backup-attested") opts.backupAttested = argv[++i] ?? "";
    else if (arg.startsWith("--backup-attested="))
      opts.backupAttested = arg.slice("--backup-attested=".length);
    else opts.errors.push(`unknown argument "${arg}"`);
  }
  if (opts.dryRun && opts.live) opts.errors.push("--dry-run and --live are mutually exclusive");
  if (opts.live && !String(opts.backupAttested ?? "").trim()) {
    opts.errors.push(
      '--live requires --backup-attested "<free text naming the fresh backup>" — take the ' +
        "backup first, then say which one it is",
    );
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
if (opts.errors.length > 0) {
  for (const error of opts.errors) console.error(`backfill-legacy-tenant-ids: ${error}`);
  console.error("backfill-legacy-tenant-ids: refused before opening any connection");
  process.exit(2);
}

const mode = opts.live ? "live" : opts.dryRun ? "dry-run" : "report";
const say = opts.json ? () => {} : (...args) => console.log(...args);

let databaseUrl;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch (e) {
  console.error(`backfill-legacy-tenant-ids: ${e.message}`);
  process.exit(1);
}

// host + database only — never the URL, which carries the password.
const target = (() => {
  try {
    const u = new URL(databaseUrl);
    return `${u.host}${u.pathname}`;
  } catch {
    return "<unparseable target>";
  }
})();

// ─── the three listings (identifiers verbatim; this schema has no @@map) ──────────────────────

const TABLES = [
  {
    table: "RouteRunStop",
    classify: classifyRouteRunStop,
    // `stopNumber` is selected for the owner's own eyeballing of the raw result if they ever run
    // this SQL by hand; it is deliberately NOT printed (numeric business data stays out of logs).
    sql: `SELECT s."id", s."createdAt", s."stopNumber", s."status", s."routeRunId",
                 rr."tenantId" AS "runTenantId", s."routeStopId",
                 rs."tenantId" AS "routeStopTenantId", rr."routeId",
                 r."tenantId" AS "routeTenantId"
            FROM "RouteRunStop" s
            LEFT JOIN "RouteRun" rr ON rr."id" = s."routeRunId"
            LEFT JOIN "RouteStop" rs ON rs."id" = s."routeStopId"
            LEFT JOIN "Route" r ON r."id" = rr."routeId"
           WHERE s."tenantId" IS NULL
           ORDER BY s."createdAt"`,
    describe: (row) => ({
      status: row.status,
      routeRunId: row.routeRunId,
      routeStopId: row.routeStopId,
      routeId: row.routeId,
      runTenantId: row.runTenantId,
      routeStopTenantId: row.routeStopTenantId,
      routeTenantId: row.routeTenantId,
    }),
  },
  {
    table: "PaymentCounter",
    classify: classifyPaymentCounter,
    // `next` is selected but never printed — it is a counter value, not an identifier.
    sql: `SELECT pc."id", pc."next", t."id" AS "parentTenantId"
            FROM "PaymentCounter" pc
            LEFT JOIN "Tenant" t ON t."id" = pc."id"
           WHERE pc."tenantId" IS NULL`,
    describe: (row) => ({ parentTenantId: row.parentTenantId }),
  },
  {
    table: "CreditNote",
    classify: classifyCreditNote,
    sql: `SELECT cn."id", cn."createdAt", cn."creditNoteNumber", cn."customerId",
                 c."tenantId" AS "customerTenantId", cn."invoiceId",
                 i."tenantId" AS "invoiceTenantId",
                 EXISTS (SELECT 1 FROM "CreditNote" x
                          WHERE x."tenantId" = c."tenantId"
                            AND x."creditNoteNumber" = cn."creditNoteNumber") AS "pairCollision"
            FROM "CreditNote" cn
            LEFT JOIN "Customer" c ON c."id" = cn."customerId"
            LEFT JOIN "Invoice" i ON i."id" = cn."invoiceId"
           WHERE cn."tenantId" IS NULL`,
    describe: (row) => ({
      creditNoteNumber: row.creditNoteNumber,
      customerId: row.customerId,
      invoiceId: row.invoiceId,
      customerTenantId: row.customerTenantId,
      invoiceTenantId: row.invoiceTenantId,
      pairCollision: row.pairCollision === true,
    }),
  },
];

// ─── formatting ───────────────────────────────────────────────────────────────────────────────

const show = (value) => {
  if (value === null || value === undefined || value === "") return "-";
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

function reportLine(report) {
  const parents = Object.entries(report.parents)
    .map(([key, value]) => `${key}=${show(value)}`)
    .join(" ");
  return (
    `${report.table}  id=${show(report.id)}  createdAt=${show(report.createdAt)}  ` +
    `${parents}  -> tenantId=${show(report.tenantId)}  [${report.verdict}] ${report.reason}`
  );
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────

let client = null;

function connect(connectionString) {
  // `pg` is required lazily so argument validation above can never be preceded by a driver load.
  const { Client } = createRequire(import.meta.url)("pg");
  return new Client({ connectionString });
}

function ask(question) {
  return new Promise((resolve) => {
    // The prompt goes to stderr so `--json --live` still emits a clean JSON document on stdout.
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  client = connect(databaseUrl);
  await client.connect();

  // Read-only for the whole session first, in every mode. `--live` lifts it explicitly, after
  // the report has been printed and the confirmation typed — never before.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '60s'");

  say(`\n=== LEGACY NULL-tenantId BACKFILL — ${mode} — ${target} ===`);
  say("    session is READ ONLY; ids and verdicts only, no business data\n");

  const reports = [];
  const perTable = [];
  for (const spec of TABLES) {
    const { rows } = await client.query(spec.sql);
    let ok = 0;
    for (const row of rows) {
      const { verdict, tenantId, reason } = spec.classify(row);
      const report = {
        table: spec.table,
        id: row.id,
        createdAt: row.createdAt ?? null,
        parents: spec.describe(row),
        verdict,
        tenantId,
        reason,
        ...(spec.table === "CreditNote" ? { creditNoteNumber: row.creditNoteNumber } : {}),
      };
      if (verdict === VERDICT_OK) ok++;
      reports.push(report);
      say(`  ${reportLine(report)}`);
    }
    if (rows.length === 0) say(`  ${spec.table}  (no NULL-tenantId rows)`);
    perTable.push({ table: spec.table, ok, refused: rows.length - ok });
    say("");
  }

  const okTotal = perTable.reduce((sum, t) => sum + t.ok, 0);
  const refusedTotal = perTable.reduce((sum, t) => sum + t.refused, 0);

  say("=== SUMMARY ===");
  for (const t of perTable) say(`  ${t.table.padEnd(16)} ok=${t.ok} refused=${t.refused}`);
  say(`  ${"TOTAL".padEnd(16)} ok=${okTotal} refused=${refusedTotal}\n`);

  // A malformed batch (see buildUpdates) must not turn the READ-ONLY report — the thing the
  // owner reads to decide — into a failure: report mode prints the refusal and still exits 0.
  // `--dry-run`/`--live` let it throw, because there is no safe write list to show or run.
  let updates = [];
  try {
    updates = buildUpdates(reports);
  } catch (e) {
    if (mode !== "report") throw e;
    console.error(`backfill-legacy-tenant-ids: no write list could be built — ${e.message}`);
  }
  const countsByTable = (list) =>
    Object.fromEntries(
      TABLES.map((spec) => [spec.table, list.filter((u) => u.table === spec.table).length]),
    );

  if (mode === "dry-run") {
    say(`=== DRY RUN — the ${updates.length} statement(s) --live would execute ===`);
    updates.forEach((update, index) => {
      say(`  [${index + 1}] ${update.sql}`);
      say(`        $1 = ${update.params[0]}`);
      say(`        $2 = ${update.params[1]}`);
    });
    say(
      `\n  ${Object.entries(countsByTable(updates))
        .map(([table, n]) => `${table}=${n}`)
        .join("  ")}`,
    );
    say("\n=== END — nothing was modified ===\n");
  }

  const applied = {};

  if (mode === "live") {
    if (updates.length === 0) {
      say("=== LIVE — no ok rows to repair; nothing to do ===\n");
    } else {
      if (!process.stdin.isTTY) {
        console.error(
          "backfill-legacy-tenant-ids: refused — --live needs an interactive TTY for the typed " +
            "confirmation, and stdin is not one",
        );
        return 3;
      }
      const phrase = `BACKFILL ${updates.length} ROWS`;
      const answer = await ask(`Type "${phrase}" to proceed: `);
      if (answer.trim() !== phrase) {
        console.error("backfill-legacy-tenant-ids: refused — confirmation text did not match");
        return 3;
      }

      say("\n  session read-only flag lifted for this repair; opening one transaction");
      await client.query("SET default_transaction_read_only = off");
      await client.query("BEGIN");
      try {
        for (const update of updates) {
          const res = await client.query(update.sql, update.params);
          if (res.rows.length !== 1) {
            await client.query("ROLLBACK");
            console.error(
              `backfill-legacy-tenant-ids: ROLLED BACK — ${update.table} ${update.id} was no ` +
                "longer NULL-tenant (it changed under us); nothing was written",
            );
            return 4;
          }
          applied[update.table] = (applied[update.table] ?? 0) + 1;
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }

      say("\n=== APPLIED ===");
      for (const [table, n] of Object.entries(applied)) say(`  ${table.padEnd(16)} ${n}`);
      say(`  ${"TOTAL".padEnd(16)} ${updates.length}\n`);
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          mode,
          target,
          generatedAt: new Date().toISOString(),
          backupAttested: opts.live ? opts.backupAttested : null,
          rows: reports.map((r) => ({ ...r, createdAt: r.createdAt?.toISOString?.() ?? null })),
          perTable,
          summary: { ok: okTotal, refused: refusedTotal },
          updates: mode === "report" ? null : updates,
          applied: mode === "live" ? applied : null,
        },
        null,
        2,
      ),
    );
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`backfill-legacy-tenant-ids: failed — ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => client?.end?.());
