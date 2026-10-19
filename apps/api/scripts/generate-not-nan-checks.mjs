#!/usr/bin/env node
/**
 * SA-816 (d)1: generate the DB backstop `CHECK (col <> 'NaN') NOT VALID` for EVERY NUMERIC column, from the Prisma
 * schema folder (never a hand list). Every Prisma `Decimal` scalar is a Postgres NUMERIC, and NUMERIC accepts 'NaN'
 * (node-pg sends a JS NaN as the string 'NaN'), so a NaN that slips past the app is stored and then poisons every sum.
 * NULL still passes (`NULL <> 'NaN'` is NULL, which a CHECK accepts).
 *
 * Usage (from the repo root; prints the migration file on stdout, writes nothing):
 *   node apps/api/scripts/generate-not-nan-checks.mjs \
 *     > apps/api/prisma/migrations/20261020090400_numeric_not_nan_checks/migration.sql
 *   node apps/api/scripts/generate-not-nan-checks.mjs --list   # one "Table.column" per line
 *   node apps/api/scripts/generate-not-nan-checks.mjs --self-test
 *
 * Regenerate the folder ONLY while it is unapplied everywhere but dev DBs (after any schema change in the bundle).
 * Once applied, the folder is immutable: a later Decimal column adds its own CHECK in its own folder, and
 * src/common/numeric-not-nan-check.spec.ts names any column that has none.
 *
 * Resolution: `@@map("t")` gives the table, `@map("c")` the column; otherwise the Prisma names. Scalar lists
 * (`Decimal[]`) are skipped (a NUMERIC[] needs a different predicate; there are none today). Constraint names are
 * `<table>_<column>_not_nan`, or, past Postgres's 63-byte identifier limit, a prefix plus an 8-hex sha1 of the full name.
 * Output order is deterministic: by table, then column.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = path.resolve(SCRIPT_DIR, "../prisma/schema");
export const FOLDER = "20261020090400_numeric_not_nan_checks";
const MAX_IDENT = 63;

/** Every scalar Decimal field in the schema text: [{ model, field, table, column }], in schema order. */
export function decimalColumns(schemaText) {
  const out = [];
  const blockRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = blockRe.exec(schemaText))) {
    const [, model, body] = m;
    const tableMap = /^\s*@@map\(\s*"([^"]+)"\s*\)/m.exec(body);
    const table = tableMap ? tableMap[1] : model;
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@")) continue;
      const f = /^(\w+)\s+(\w+)(\[\])?(\?)?(\s.*)?$/.exec(line);
      if (!f || f[2] !== "Decimal" || f[3]) continue;
      const colMap = /@map\(\s*"([^"]+)"\s*\)/.exec(f[5] ?? "");
      out.push({ model, field: f[1], table, column: colMap ? colMap[1] : f[1] });
    }
  }
  return out;
}

/** Read and concatenate the schema folder's *.prisma files (sorted, so the result is stable). */
export function readSchemaFolder(dir = SCHEMA_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".prisma"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

/**
 * Deterministic constraint name, at most 63 BYTES (Postgres's NAMEDATALEN - 1, counted in bytes, not characters). Past
 * that: the longest whole-character prefix that fits, then `_<8-hex sha1 of the full name>_not_nan`.
 */
export function constraintName(table, column) {
  const full = `${table}_${column}_not_nan`;
  if (Buffer.byteLength(full) <= MAX_IDENT) return full;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 8);
  const keep = MAX_IDENT - Buffer.byteLength(`_${hash}_not_nan`);
  let prefix = "";
  for (const ch of full) {
    if (Buffer.byteLength(prefix + ch) > keep) break;
    prefix += ch;
  }
  return `${prefix}_${hash}_not_nan`;
}

/** Sorted, de-duplicated columns grouped by table: Map<table, column[]>. */
export function byTable(cols) {
  const map = new Map();
  // Code-point order, never localeCompare: the output must not depend on the machine's locale.
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  for (const c of [...cols].sort((a, b) => cmp(a.table, b.table) || cmp(a.column, b.column))) {
    if (!map.has(c.table)) map.set(c.table, []);
    const list = map.get(c.table);
    if (!list.includes(c.column)) list.push(c.column);
  }
  return map;
}

/** The whole migration.sql text for these columns. */
export function renderMigration(cols) {
  const tables = byTable(cols);
  const count = [...tables.values()].reduce((n, l) => n + l.length, 0);
  const head = `-- SA-816 (d)1, sitting 4 folder 6: the DB backstop against NaN in money / quantity math.
--   CHECK ("<col>" <> 'NaN') NOT VALID on EVERY NUMERIC column: ${count} columns on ${tables.size} tables (every Prisma
--   \`Decimal\` scalar, @map/@@map resolved; it includes the columns this bundle's earlier folders add). NUMERIC accepts
--   'NaN' and node-pg sends a JS NaN as 'NaN', so one bad bind is stored and then poisons every sum. NULL still passes.
--
-- GENERATED, never hand-edited: \`node apps/api/scripts/generate-not-nan-checks.mjs > <this file>\` from the repo root,
-- reading apps/api/prisma/schema. Regenerate it only while this folder is unapplied (after any schema change in the
-- bundle). Once applied it is immutable: a later Decimal column adds its own CHECK in its own folder
-- (src/common/numeric-not-nan-check.spec.ts names every column without one).
--
-- NOT VALID: no table scan, and existing rows are NOT checked (SA-816's 101 InvoiceItem.categoryTaxAmount NaN
-- lines on 4 invoices stay until the R593 repair). Postgres enforces the CHECK on every INSERT and on every UPDATE
-- from the moment this commits, so an UPDATE of a row that still holds NaN fails unless the same UPDATE replaces the
-- NaN. VALIDATE is a SEPARATE later folder, per column, after a census reads 0 NaN (SA-816 (d)1).
-- CHECKs are raw SQL (Prisma does not model them), so the schema and the drift gate are unaffected (the T6 precedent,
-- 20260920220000_t6_tenantid_check_not_valid).
--
-- LOCK PROFILE: ONE transaction (the T6 precedent), ONE ALTER TABLE per table (all its CHECKs in one statement). Each
-- ALTER takes a brief ACCESS EXCLUSIVE lock (metadata-only: no scan, no rewrite), and every lock is held until COMMIT.
-- \`SET LOCAL lock_timeout = '5s'\` bounds each WAIT; a wait past 5s (or a deadlock with live traffic) aborts the
-- statement and the WHOLE folder rolls back cleanly: no constraint is left half-added and no data is touched. It is
-- recorded FAILED: recover with
-- \`prisma migrate resolve --rolled-back ${FOLDER}\` from apps/api, then re-run it;
-- NEVER \`--applied\`.
--
-- RUNBOOK PRE-STEP (before applying, read-only): run it OFF-PEAK, and first check pg_stat_activity for long-running
-- or idle-in-transaction sessions (any one holding a lock on these tables makes an ACCESS EXCLUSIVE wait, and every
-- reader queues behind that wait), e.g.
--   SELECT pid, state, now() - xact_start AS xact_age, left(query, 60) FROM pg_stat_activity
--    WHERE datname = current_database() AND pid <> pg_backend_pid()
--      AND (state = 'idle in transaction' OR now() - xact_start > interval '30 seconds');
-- and confirm no pg_dump / backup is still running (it holds ACCESS SHARE on every table until it finishes). Apply
-- only when that returns nothing; otherwise wait (or ask the owner) and re-check.
--
-- Rollback (instant, no data touched): ALTER TABLE "<t>" DROP CONSTRAINT "<name>"; for each constraint below. The
-- name is "<t>_<col>_not_nan", or, past 63 bytes, a prefix + "_<8-hex>_not_nan": copy the exact names from below.

BEGIN;
SET LOCAL lock_timeout = '5s';
`;
  const body = [...tables]
    .map(([table, columns]) => {
      const adds = columns.map(
        (c) =>
          `  ADD CONSTRAINT "${constraintName(table, c)}" CHECK ("${c}" <> 'NaN'::numeric) NOT VALID`,
      );
      return `ALTER TABLE "${table}"\n${adds.join(",\n")};`;
    })
    .join("\n\n");
  return `${head}\n${body}\n\nCOMMIT;\n`;
}

export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const schema = `model A {
  id    String  @id
  price Decimal @db.Decimal(10, 2) // a comment
  rate  Decimal? @map("rate_col")
  // qty Decimal (commented out)
  list  Decimal[]
  n     Int
}

model B {
  amount Decimal
  @@map("b_table")
}
`;
  eq(
    decimalColumns(schema).map((c) => `${c.table}.${c.column}`),
    ["A.price", "A.rate_col", "b_table.amount"],
    "columns",
  );
  eq(constraintName("A", "price"), "A_price_not_nan", "short name");
  const long = constraintName("T".repeat(40), "c".repeat(40));
  if (Buffer.byteLength(long) > MAX_IDENT || !long.endsWith("_not_nan"))
    throw new Error("long name");
  if (long !== constraintName("T".repeat(40), "c".repeat(40))) throw new Error("not deterministic");
  const wide = constraintName("é".repeat(40), "c"); // 2 bytes per char: truncation counts bytes, never splits a char
  if (Buffer.byteLength(wide) > MAX_IDENT || !/^é+_[0-9a-f]{8}_not_nan$/.test(wide))
    throw new Error(`multibyte name: ${wide}`);
  const sql = renderMigration(decimalColumns(schema));
  if (!sql.includes(`ALTER TABLE "A"\n  ADD CONSTRAINT "A_price_not_nan"`)) throw new Error("sql");
  if (!sql.includes(`CHECK ("rate_col" <> 'NaN'::numeric) NOT VALID`)) throw new Error("sql map");
  return "self-test ok";
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const cols = decimalColumns(readSchemaFolder());
  if (argv.includes("--list")) {
    for (const [t, list] of byTable(cols)) for (const c of list) console.log(`${t}.${c}`);
    return;
  }
  process.stdout.write(renderMigration(cols));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
