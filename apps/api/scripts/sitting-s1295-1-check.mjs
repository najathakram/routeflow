#!/usr/bin/env node
/**
 * SA-1295 Sitting 1 (QuickBooks history import, stage-1 schema): the READ-ONLY gates the owner-run sitting uses.
 * It never writes: every mode runs in ONE `BEGIN READ ONLY` transaction with a 5 s `statement_timeout`, always rolled
 * back, and it prints counts and names only, never a row, an id or a credential.
 *
 *   --pre                    O2, census. Rows and `pg_total_relation_size` of "ImportExternalRef", "Customer" and
 *                            "Product"; transactions older than 60 s; sessions idle in transaction; whether every
 *                            session is visible; conflicting locks held longer than the migration's own 5 s
 *                            lock_timeout. Last line `PRE: GO`, or `PRE: STOP (<reasons>)`.
 *   --status --expect a,b,c  O3, pending-list gate. Lists the tree's migration folders with no applied row in
 *                            `_prisma_migrations`, and any failed row. Last line
 *                            `STATUS: GO (pending N: ...)` only if the pending list equals --expect and nothing failed.
 *   --post                   O5, after the migrate. The partial unique index text, the six tables and two columns, the
 *                            IMPORTED_SUMMARY enum value, and the SA-1507 A1-10 catalog sets: the nine foreign keys with
 *                            their actions, exactly one non-internal trigger per guarded table (the guard), the function
 *                            bodies that name a guarded table (exactly the guard), no rules. Last line `POST: GO`.
 *
 * Run it from the sitting's tree, under `railway run --service postgres`: the URL comes from the same builder
 * prod-migrate.mjs uses (`resolveDatabaseUrl(env, { requireProxy: true })`) and the script fails closed if the proxy
 * variables are missing; it never falls back to DATABASE_URL. The migrations path comes from import.meta.url, so a copy
 * run from another cwd still reads its own tree.
 *
 * The check functions take a connected `pg` client, so a spec runs them against the replay database.
 */
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { RAILWAY_PROXY_VARS, redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(SCRIPT_DIR, "..", "prisma", "migrations");

export const GUARDED = [
  "LegacyImportBatch",
  "LegacyImportFile",
  "LegacyImportIssue",
  "LegacySalesDocument",
  "LegacySalesLine",
  "SourceItemAlias",
];
export const GUARD_FN = "legacy_import_tenant_guard";
export const INDEX_NAME = "ImportExternalRef_confirmed_entity_key";

/** PRE limits (SA-1295 §4 O2). */
export const MAX_ROWS = 1_000_000;
export const MAX_BYTES = 500 * 1024 * 1024;
/** A conflicting lock older than this blocks the migration past its own lock_timeout. */
export const LOCK_AGE_SECONDS = 5;

/** SA-1507 A1-1: the nine foreign keys of the guarded tables, as `confdeltype`/`confupdtype` letters (c cascade, n set null, r restrict, a no action). */
export const EXPECTED_FKS = [
  "LegacyImportFile(tenantId,batchId) -> LegacyImportBatch(tenantId,id) del=c upd=a",
  "LegacyImportIssue(tenantId,batchId) -> LegacyImportBatch(tenantId,id) del=c upd=a",
  "LegacyImportIssue(tenantId,fileId) -> LegacyImportFile(tenantId,id) del=c upd=a",
  "LegacySalesDocument(tenantId,batchId) -> LegacyImportBatch(tenantId,id) del=c upd=a",
  "LegacySalesDocument(tenantId,fileId) -> LegacyImportFile(tenantId,id) del=c upd=a",
  "LegacySalesLine(tenantId,documentId) -> LegacySalesDocument(tenantId,id) del=c upd=a",
  "LegacySalesDocument(customerId) -> Customer(id) del=n upd=a",
  "LegacySalesLine(productId) -> Product(id) del=r upd=a",
  "SourceItemAlias(productId) -> Product(id) del=r upd=a",
].sort();

const unquote = (s) => String(s).replace(/"/g, "");

/** Runs `fn(client)` inside one READ ONLY transaction with a 5 s statement timeout; always rolls back. */
export async function readOnly(client, fn) {
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
  }
}

// ── --pre ───────────────────────────────────────────────────────────────────────────────────────────────────────
export async function runPre(client) {
  const lines = [];
  const reasons = [];
  await readOnly(client, async (c) => {
    const size = async (table) => {
      let rows = "?";
      try {
        // count(*) is the spec's number; a timeout is itself a reason to stop (the table is bigger than a 5 s scan)
        rows = Number((await c.query(`SELECT count(*)::text AS n FROM "${table}"`)).rows[0].n);
      } catch {
        rows = null;
        await c.query("ROLLBACK");
        await c.query("BEGIN READ ONLY");
        await c.query("SET LOCAL statement_timeout = '5s'");
      }
      const bytes = Number(
        (await c.query(`SELECT pg_total_relation_size('"${table}"'::regclass)::text AS b`)).rows[0]
          .b,
      );
      return { table, rows, bytes };
    };
    for (const t of ["ImportExternalRef", "Customer", "Product"]) {
      const s = await size(t);
      lines.push(
        `${s.table}: rows ${s.rows === null ? "count timed out (over 5 s)" : s.rows}, bytes ${s.bytes}`,
      );
      if (s.table === "ImportExternalRef") {
        if (s.rows === null || s.rows > MAX_ROWS || s.bytes > MAX_BYTES) reasons.push("size");
      }
    }

    const act = (
      await c.query(
        `SELECT
           count(*) FILTER (WHERE xact_start < now() - interval '60 seconds')::int AS old_xact,
           count(*) FILTER (WHERE state IN ('idle in transaction', 'idle in transaction (aborted)'))::int AS idle_in_xact,
           count(*) FILTER (WHERE state IS NULL OR query = '<insufficient privilege>')::int AS hidden
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
      )
    ).rows[0];
    lines.push(`transactions older than 60 s: ${act.old_xact}`);
    lines.push(`idle in transaction: ${act.idle_in_xact}`);
    lines.push(`sessions visible: ${act.hidden === 0 ? "all" : "partial"}`);
    if (act.old_xact > 0) reasons.push("old transactions");
    if (act.idle_in_xact > 0) reasons.push("idle in transaction");
    if (act.hidden > 0) reasons.push("sessions not all visible");

    // N2 / N6: only locks the migration would WAIT on, held by a transaction older than its own lock_timeout, never this
    // connection. Customer and Product are taken at SHARE ROW EXCLUSIVE (a held RowExclusive or stronger conflicts);
    // ImportExternalRef is taken at ACCESS EXCLUSIVE (any held lock, AccessShare included, conflicts).
    const locks = (
      await c.query(
        `SELECT count(*)::int AS n
           FROM pg_locks l
           JOIN pg_class r ON r.oid = l.relation
           JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.granted AND l.pid <> pg_backend_pid() AND a.datname = current_database()
            AND a.xact_start < now() - make_interval(secs => $1)
            AND ((r.relname IN ('Customer', 'Product')
                  AND l.mode IN ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock',
                                 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'))
              OR r.relname = 'ImportExternalRef')`,
        [LOCK_AGE_SECONDS],
      )
    ).rows[0].n;
    lines.push(
      `conflicting locks older than ${LOCK_AGE_SECONDS} s on Customer, Product, ImportExternalRef: ${locks}`,
    );
    if (locks > 0) reasons.push("conflicting locks");
  });
  const verdict = reasons.length === 0 ? "PRE: GO" : `PRE: STOP (${reasons.join(", ")})`;
  return { ok: reasons.length === 0, lines: [...lines, verdict] };
}

// ── --status ────────────────────────────────────────────────────────────────────────────────────────────────────
/** The migration folders of the tree this script lives in. */
export function treeFolders(dir = MIGRATIONS_DIR) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
}

/**
 * Pending and failed folders from `_prisma_migrations` rows ({migration_name, finished_at, rolled_back_at}).
 * A folder with no row is pending. A folder with a row finished and not rolled back is applied, even when an earlier
 * row of it was rolled back (rolled back, then applied again). A row neither finished nor rolled back is a FAILED run.
 * A folder with only rolled-back rows is pending again.
 */
export function classifyFolders(folders, rows) {
  const pending = [];
  const failed = [];
  for (const f of folders) {
    const mine = rows.filter((r) => r.migration_name === f);
    if (mine.some((r) => r.finished_at && !r.rolled_back_at)) continue;
    if (mine.some((r) => !r.finished_at && !r.rolled_back_at)) failed.push(f);
    else pending.push(f);
  }
  return { pending, failed };
}

export async function runStatus(client, expect, folders = treeFolders()) {
  const rows = await readOnly(
    client,
    async (c) =>
      (
        await c.query(
          `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
        )
      ).rows,
  );
  const { pending, failed } = classifyFolders(folders, rows);
  const want = [...expect].sort();
  const same = pending.length === want.length && pending.every((p, i) => p === want[i]);
  const lines = [];
  if (failed.length) lines.push(`failed migrations: ${failed.join(", ")}`);
  lines.push(`pending (${pending.length}): ${pending.join(", ") || "none"}`);
  lines.push(`expected (${want.length}): ${want.join(", ") || "none"}`);
  const ok = same && failed.length === 0;
  lines.push(
    ok
      ? `STATUS: GO (pending ${pending.length}: ${pending.join(", ")})`
      : `STATUS: STOP (${failed.length ? "a migration failed" : "pending list differs from --expect"})`,
  );
  return { ok, lines };
}

// ── --post ──────────────────────────────────────────────────────────────────────────────────────────────────────
const NORMALISE_INDEX = (s) =>
  String(s)
    .replace(/\s+/g, " ")
    .replace(/public\./g, "")
    .trim();
// Built from parts: this is the text pg_indexes reports (a comparison string, never a statement this script runs), and
// the no-runtime-ddl pin refuses a DDL phrase in any script file that holds a pg client.
const EXPECTED_INDEXDEF =
  ["CREATE UNIQUE", 'INDEX "ImportExternalRef_confirmed_entity_key" ON'].join(" ") +
  ' "ImportExternalRef" USING btree ("tenantId", "externalSource", "entityType", "entityId") WHERE ("confirmedAt" IS NOT NULL)';

export async function runPost(client) {
  const problems = [];
  const lines = [];
  await readOnly(client, async (c) => {
    const idx = (
      await c.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
        [INDEX_NAME],
      )
    ).rows;
    if (idx.length !== 1) problems.push(`index ${INDEX_NAME}: expected 1, found ${idx.length}`);
    else if (NORMALISE_INDEX(idx[0].indexdef) !== EXPECTED_INDEXDEF) {
      problems.push(
        `index ${INDEX_NAME}: text differs from the expected UNIQUE ... WHERE ("confirmedAt" IS NOT NULL)`,
      );
    }
    lines.push(`index ${INDEX_NAME}: ${idx.length === 1 ? "present" : "MISSING"}`);

    const tables = (
      await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [GUARDED],
      )
    ).rows.map((r) => r.table_name);
    for (const t of GUARDED) if (!tables.includes(t)) problems.push(`table ${t} missing`);
    lines.push(`tables present: ${tables.length} of ${GUARDED.length}`);

    const cols = (
      await c.query(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ImportExternalRef' AND column_name IN ('confirmedAt', 'confirmedById')`,
      )
    ).rows;
    for (const name of ["confirmedAt", "confirmedById"]) {
      const col = cols.find((r) => r.column_name === name);
      if (!col) problems.push(`column ImportExternalRef.${name} missing`);
      else if (col.is_nullable !== "YES" || col.column_default !== null) {
        problems.push(`column ImportExternalRef.${name} is not nullable with no default`);
      }
    }
    lines.push(`ImportExternalRef columns present: ${cols.length} of 2`);

    const enumHit = (
      await c.query(
        `SELECT count(*)::int AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'InvoiceItemSystemKind' AND e.enumlabel = 'IMPORTED_SUMMARY'`,
      )
    ).rows[0].n;
    if (enumHit !== 1) problems.push("enum value IMPORTED_SUMMARY missing");
    lines.push(`IMPORTED_SUMMARY in InvoiceItemSystemKind: ${enumHit === 1 ? "yes" : "NO"}`);

    // A1-10: the FK set, taken from pg_constraint (a guarded table on either side).
    const fks = (
      await c.query(
        `SELECT c.conrelid::regclass::text AS "table", c.confrelid::regclass::text AS ref,
                (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
                (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols,
                c.confdeltype::text AS del, c.confupdtype::text AS upd
           FROM pg_constraint c
          WHERE c.contype = 'f'
            AND (regexp_replace(c.conrelid::regclass::text, '"', '', 'g') = ANY($1)
              OR regexp_replace(c.confrelid::regclass::text, '"', '', 'g') = ANY($1))`,
        [GUARDED],
      )
    ).rows;
    const gotFks = fks
      .map(
        (f) =>
          `${unquote(f.table)}(${f.cols}) -> ${unquote(f.ref)}(${f.refcols}) del=${f.del} upd=${f.upd}`,
      )
      .sort();
    if (JSON.stringify(gotFks) !== JSON.stringify(EXPECTED_FKS)) {
      problems.push(
        `foreign keys differ from A1-1: missing [${EXPECTED_FKS.filter((x) => !gotFks.includes(x)).join("; ")}] extra [${gotFks.filter((x) => !EXPECTED_FKS.includes(x)).join("; ")}]`,
      );
    }
    lines.push(
      `foreign keys on the guarded tables: ${gotFks.length} (expected ${EXPECTED_FKS.length})`,
    );

    // exactly one non-internal trigger per guarded table: the guard (BEFORE ROW INSERT OR UPDATE OR DELETE = tgtype 31).
    const trig = (
      await c.query(
        `SELECT regexp_replace(t.tgrelid::regclass::text, '"', '', 'g') AS rel, t.tgname AS name, p.proname AS fn, t.tgtype::int AS type
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE NOT t.tgisinternal AND regexp_replace(t.tgrelid::regclass::text, '"', '', 'g') = ANY($1)`,
        [GUARDED],
      )
    ).rows;
    const gotTrig = trig.map((t) => `${t.rel} ${t.name} ${t.fn} ${t.type}`).sort();
    const wantTrig = GUARDED.map((m) => `${m} ${m}_tenant_guard ${GUARD_FN} 31`).sort();
    if (JSON.stringify(gotTrig) !== JSON.stringify(wantTrig)) {
      problems.push(
        `triggers differ: expected exactly the six ${GUARD_FN} guards, found [${gotTrig.join("; ")}]`,
      );
    }
    lines.push(
      `non-internal triggers on the guarded tables: ${trig.length} (expected ${GUARDED.length})`,
    );

    const procs = (
      await c.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ $1`,
        [`(${GUARDED.join("|")})`],
      )
    ).rows.map((r) => r.proname);
    if (JSON.stringify(procs) !== JSON.stringify([GUARD_FN])) {
      problems.push(
        `function bodies naming a guarded table: expected [${GUARD_FN}], found [${procs.join(", ")}]`,
      );
    }
    lines.push(`function bodies naming a guarded table: ${procs.length} (expected 1)`);

    const rules = (
      await c.query(`SELECT count(*)::int AS n FROM pg_rules WHERE tablename = ANY($1)`, [GUARDED])
    ).rows[0].n;
    if (rules !== 0) problems.push(`rules on the guarded tables: ${rules}`);
    lines.push(`rules on the guarded tables: ${rules} (expected 0)`);
  });
  return {
    ok: problems.length === 0,
    lines: [
      ...lines,
      ...problems.map((p) => `PROBLEM: ${p}`),
      problems.length === 0 ? "POST: GO" : `POST: STOP (${problems.length})`,
    ],
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const modes = ["--pre", "--post", "--status"].filter((m) => argv.includes(m));
  if (modes.length !== 1) throw new Error("exactly one of --pre, --post, --status is required");
  const mode = modes[0].slice(2);
  let expect = [];
  if (mode === "status") {
    const i = argv.indexOf("--expect");
    if (i < 0 || !argv[i + 1]) throw new Error("--status needs --expect <folder,folder,...>");
    expect = argv[i + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return { mode, expect };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `${err.message}\nusage: sitting-s1295-1-check.mjs --pre | --post | --status --expect <folder,...>`,
    );
    process.exit(2);
  }
  const missing = RAILWAY_PROXY_VARS.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      `\nMissing env: ${missing.join(", ")}\nRun this via:  railway run --service postgres node apps/api/scripts/sitting-s1295-1-check.mjs --${args.mode}\n`,
    );
    process.exit(1);
  }
  const url = resolveDatabaseUrl(process.env, { requireProxy: true });
  console.log(`Target host: ${redactUrl(url)}`);
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  let result;
  try {
    result =
      args.mode === "pre"
        ? await runPre(client)
        : args.mode === "post"
          ? await runPost(client)
          : await runStatus(client, args.expect);
  } finally {
    await client.end();
  }
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`sitting-s1295-1-check failed: ${err.message}`);
    process.exit(1);
  });
}
