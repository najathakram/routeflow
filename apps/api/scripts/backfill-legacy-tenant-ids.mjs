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
 * ONE CASCADE LEVEL. The read-only report of 2026-09-05 refused all five stops for a single
 * reason: their parent `RouteRun` rows are THEMSELVES NULL-tenant — two runs, one carrying 1 stop
 * and one carrying 4 — even though every stop's `RouteStop` and the run's `Route` name the same
 * tenant. So a NULL-tenant `RouteRun` is now repaired FIRST, from its `Route`, and only when every
 * `RouteStop` reached through that run agrees with it; its stops are then classified against that
 * not-yet-written tenant (reported as `(via run repaired in this batch)`). Nothing else is
 * relaxed — a stop still needs its own `RouteStop` and `Route` to equal that tenant, and a stop
 * whose run was refused stays refused. In `--live` the `RouteRun` updates execute before the stop
 * updates inside the SAME single transaction, so the batch is still all-or-nothing.
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
 * A malformed batch (see `buildUpdates`) blocks report and `--dry-run` rather than failing them:
 * the refusal is printed to BOTH stdout and stderr, `--json` carries it as `batchError` with
 * `summary.blocked: true` (`summary.ok` still counts the ok rows), and the exit stays 0. `--live`
 * lets it throw — there is nothing safe to run.
 *
 * TEST-ONLY HOOK
 *   BACKFILL_CONFIRM_TOKEN — supplies the typed confirmation as a value instead of reading a
 *   TTY, so `apps/api/src/common/backfill-legacy-tenant-ids.db.spec.ts` can execute the --live
 *   path against the compose database. Honoured ONLY inside a jest worker (JEST_WORKER_ID set)
 *   that also sets it, with a WARNING line; ignored — loudly — anywhere else. It does NOT relax
 *   `--backup-attested`, and a value that does not match `BACKFILL <n> ROWS` is still exit 3.
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
  classifyRouteRun,
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

Tables, in write order: RouteRun, RouteRunStop, PaymentCounter, CreditNote. A NULL-tenant RouteRun
is repaired from its Route first, and its NULL-tenant stops are then derived from that tenant —
one cascade level, in the same transaction, parents before children.

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

// ─── the four listings, in cascade order (identifiers verbatim; this schema has no @@map) ─────

const TABLES = [
  {
    // FIRST, and that ordering is load-bearing: a NULL-tenant RouteRun classified here feeds
    // `ctx.repairedRunTenants`, which the RouteRunStop listing below reads as the tenant its own
    // NULL-tenant stops are judged against. (The TRANSACTION order is decided independently by
    // `buildUpdates`, from BACKFILL_TABLES — this ordering is about the report and the map.)
    table: "RouteRun",
    classify: classifyRouteRun,
    onOk: (row, tenantId, ctx) => ctx.repairedRunTenants.set(row.id, tenantId),
    // `stopTenantIds` is the DISTINCT set of non-NULL RouteStop tenants reached through this
    // run's stops: a check on the Route-derived tenant, never a source for it. `array_agg` over
    // zero rows yields NULL rather than an empty array, which classifyRouteRun normalises.
    // `stopCount` is printed so the owner can see how much a single run repair unblocks.
    sql: `SELECT rr."id", rr."createdAt", rr."routeId",
                 r."id" AS "routeRowId", r."tenantId" AS "routeTenantId",
                 (SELECT count(*)::int FROM "RouteRunStop" s
                   WHERE s."routeRunId" = rr."id") AS "stopCount",
                 (SELECT array_agg(DISTINCT rs."tenantId")
                    FROM "RouteRunStop" s
                    JOIN "RouteStop" rs ON rs."id" = s."routeStopId"
                   WHERE s."routeRunId" = rr."id"
                     AND rs."tenantId" IS NOT NULL) AS "stopTenantIds"
            FROM "RouteRun" rr
            LEFT JOIN "Route" r ON r."id" = rr."routeId"
           WHERE rr."tenantId" IS NULL
           ORDER BY rr."createdAt"`,
    describe: (row) => ({
      routeId: row.routeId,
      routeRowId: row.routeRowId,
      routeTenantId: row.routeTenantId,
      stopCount: row.stopCount,
      stopTenantIds: row.stopTenantIds ?? [],
    }),
  },
  {
    table: "RouteRunStop",
    classify: (row, ctx) =>
      classifyRouteRunStop({
        ...row,
        // Supplied ONLY for a stop whose run is itself NULL-tenant, and only from runs whose own
        // verdict was `ok` — `onOk` above is the only writer of this map. A stop under a REFUSED
        // run therefore sees nothing here and stays `refuse: parent missing`.
        effectiveRunTenantId: row.runTenantId
          ? null
          : (ctx.repairedRunTenants.get(row.routeRunId) ?? null),
      }),
    noteFor: (row, verdict, ctx) =>
      !row.runTenantId && verdict === VERDICT_OK && ctx.repairedRunTenants.has(row.routeRunId)
        ? "(via run repaired in this batch)"
        : null,
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
                 i."id" AS "invoiceRowId", i."tenantId" AS "invoiceTenantId",
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
      // `invoiceRowId` is the joined Invoice."id": NULL here with a non-NULL `invoiceId` means
      // the parent row is GONE, which the tenant column alone cannot distinguish from "no
      // invoice linked". classifyCreditNote refuses both.
      invoiceRowId: row.invoiceRowId,
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
    `${parents}  -> tenantId=${show(report.tenantId)}  [${report.verdict}] ${report.reason}` +
    // e.g. "(via run repaired in this batch)" — the stop's own RouteRun is NULL-tenant and the
    // tenant above is the one this same batch will write to it.
    (report.note ? ` ${report.note}` : "")
  );
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────

let client = null;

function connect(connectionString) {
  // `pg` is required lazily so argument validation above can never be preceded by a driver load.
  const { Client } = createRequire(import.meta.url)("pg");
  return new Client({ connectionString });
}

// Test-only: the typed confirmation, supplied as a value instead of read from a TTY, so the
// DB-lane spec can execute the --live path end to end. Honoured ONLY inside a jest worker that
// also sets it, announced loudly when honoured, and ignored — also loudly — anywhere else, the
// same shape as SCHEMA_DRIFT_PRISMA_CLI in schema-drift.mjs and the four overrides in
// scripts/visibility-watchdog.mjs. It never relaxes --backup-attested: an unattended --live
// still has to name a backup.
function confirmTokenOverride() {
  const raw = process.env.BACKFILL_CONFIRM_TOKEN;
  if (!raw) return undefined;
  if (!process.env.JEST_WORKER_ID) {
    console.error(
      "backfill-legacy-tenant-ids: BACKFILL_CONFIRM_TOKEN is ignored outside test " +
        "(JEST_WORKER_ID unset); the confirmation must be typed on a TTY",
    );
    return undefined;
  }
  console.error(
    "backfill-legacy-tenant-ids: WARNING: test override BACKFILL_CONFIRM_TOKEN active — " +
      "this is NOT an owner-typed confirmation",
  );
  return raw;
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
  // Threaded through the listings in TABLES order. RouteRun is listed and classified first, so by
  // the time the RouteRunStop listing runs this map already holds the tenant every `ok` run will
  // be given — which is what lets a stop under a NULL-tenant run be derived in the same batch.
  const ctx = { repairedRunTenants: new Map() };
  for (const spec of TABLES) {
    const { rows } = await client.query(spec.sql);
    let ok = 0;
    for (const row of rows) {
      const { verdict, tenantId, reason } = spec.classify(row, ctx);
      if (verdict === VERDICT_OK) spec.onOk?.(row, tenantId, ctx);
      const note = spec.noteFor?.(row, verdict, ctx) ?? null;
      const report = {
        table: spec.table,
        id: row.id,
        createdAt: row.createdAt ?? null,
        parents: spec.describe(row),
        verdict,
        tenantId,
        reason,
        ...(note ? { note } : {}),
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

  // A malformed batch (see buildUpdates) must not turn a READ-ONLY run — the thing the owner
  // reads to decide — into a failure: report and --dry-run print the refusal and still exit 0
  // with `summary.blocked: true`. Only --live lets it throw, because there is nothing safe to
  // run. The refusal goes to stdout as well as stderr (and into --json as `batchError`): an
  // owner who redirected the report to a file must not end up with a document that looks
  // complete while the one line explaining why it is empty went somewhere else.
  let updates = [];
  let batchError = null;
  try {
    updates = buildUpdates(reports);
  } catch (e) {
    if (mode === "live") throw e;
    batchError = `backfill-legacy-tenant-ids: no write list could be built — ${e.message}`;
    console.error(batchError);
    say(batchError);
  }
  const countsByTable = (list) =>
    Object.fromEntries(
      TABLES.map((spec) => [spec.table, list.filter((u) => u.table === spec.table).length]),
    );

  if (mode === "dry-run") {
    say(
      batchError
        ? "=== DRY RUN — BLOCKED, no write list could be built; nothing to show ==="
        : `=== DRY RUN — the ${updates.length} statement(s) --live would execute ===`,
    );
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
      const injected = confirmTokenOverride();
      if (injected === undefined && !process.stdin.isTTY) {
        console.error(
          "backfill-legacy-tenant-ids: refused — --live needs an interactive TTY for the typed " +
            "confirmation, and stdin is not one",
        );
        return 3;
      }
      const phrase = `BACKFILL ${updates.length} ROWS`;
      const answer = injected ?? (await ask(`Type "${phrase}" to proceed: `));
      if (answer.trim() !== phrase) {
        console.error("backfill-legacy-tenant-ids: refused — confirmation text did not match");
        return 3;
      }

      say("\n  session read-only flag lifted for this repair; opening one transaction");
      await client.query("SET default_transaction_read_only = off");
      await client.query("BEGIN");
      try {
        // `buildUpdates` already ordered these by BACKFILL_TABLES, so every RouteRun repair
        // precedes the stop repairs that depend on it — inside this ONE transaction, so a stop
        // that changed under us rolls the parent run back with it.
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
          summary: {
            ok: okTotal,
            refused: refusedTotal,
            ...(batchError ? { blocked: true } : {}),
          },
          ...(batchError ? { batchError } : {}),
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
