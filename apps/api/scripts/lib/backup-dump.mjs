// Pure helpers behind apps/api/scripts/backup-production.mjs — kept separate so the parts that
// decide "is this dump trustworthy" and "how is pg_dump invoked" are unit-testable without a
// database, a Railway link, or a pg_dump binary.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** A prod dump below either floor is not the production database (125+ models, 200+ migrations). */
export const MIN_TABLES = 100;

/** `COPY public._prisma_migrations (...)` — pg_dump emits it unquoted; accept a quoted form too. */
const MIGRATIONS_COPY_RE = /^COPY public\.(?:_prisma_migrations|"_prisma_migrations") /;
const CREATE_TABLE_RE = /^CREATE TABLE public\./;
/** pg_dump ends every COPY data block with a line holding exactly backslash + dot. */
const COPY_TERMINATOR = "\\.";

/**
 * Scans a plain-format dump line by line (works on an array or on a readline async iterator, so a
 * multi-hundred-MB dump is never held in memory) and reports what proves it is the full prod DB.
 * `migrationRows` counts the DATA rows inside the `_prisma_migrations` COPY block — the header and
 * the `\.` terminator are not rows — and is -1 only when there is no such block at all.
 */
export async function scanDump(lines) {
  let tables = 0;
  let copyBlocks = 0;
  let migrationRows = -1;
  let inMigrations = false;
  let total = 0;
  for await (const raw of lines) {
    total++;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (inMigrations) {
      if (line === COPY_TERMINATOR) inMigrations = false;
      else migrationRows++;
      continue;
    }
    if (CREATE_TABLE_RE.test(line)) tables++;
    else if (line.startsWith("COPY ")) {
      copyBlocks++;
      if (MIGRATIONS_COPY_RE.test(line)) {
        migrationRows = 0;
        inMigrations = true;
      }
    }
  }
  return { lines: total, tables, copyBlocks, migrationRows };
}

/** Why a scan result cannot be trusted as a prod backup — empty array means it can. */
export function dumpProblems(stats) {
  const problems = [];
  if (stats.tables < MIN_TABLES) {
    problems.push(`only ${stats.tables} CREATE TABLE statements (need >= ${MIN_TABLES})`);
  }
  if (stats.migrationRows < 0) {
    problems.push(
      "no COPY public._prisma_migrations block (the dump is missing migration history)",
    );
  } else if (stats.migrationRows === 0) {
    problems.push("the _prisma_migrations COPY block has 0 rows");
  }
  return problems;
}

/** Local-time stamp, same shape the old .sh used: YYYYMMDD_HHMMSS. */
export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `production_<ts>_<label>.sql`; the label is reduced to filename-safe characters. */
export function backupFileName(label, d = new Date()) {
  const safe = String(label || "").replace(/[^A-Za-z0-9._-]/g, "-") || "manual";
  return `production_${timestamp(d)}_${safe}.sql`;
}

/**
 * The pg_dump argv + env for the Railway TCP proxy. The password travels ONLY in PGPASSWORD —
 * argv is visible to every local process (and lands in shell history / process listings).
 */
export function buildPgDumpInvocation(env, file) {
  return {
    args: [
      "-h",
      env.RAILWAY_TCP_PROXY_DOMAIN,
      "-p",
      env.RAILWAY_TCP_PROXY_PORT,
      "-U",
      env.POSTGRES_USER,
      "-d",
      env.POSTGRES_DB,
      "--no-password",
      "--format=plain",
      "--no-acl",
      "--no-owner",
      "-f",
      file,
    ],
    env: { ...env, PGPASSWORD: env.POSTGRES_PASSWORD, PGSSLMODE: env.PGSSLMODE || "prefer" },
  };
}

function versionKey(name) {
  return name.split(".").map((n) => parseInt(n, 10) || 0);
}

function compareVersionsDesc(a, b) {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Finds pg_dump: PATH first, then the newest `C:\Program Files\PostgreSQL\<ver>\bin` install.
 * `probe(cmd)` and `listDir(dir)` are injectable so the search order is testable.
 */
export function findPgDump({
  probe = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0,
  listDir = (dir) => readdirSync(dir),
  programFiles = process.env.ProgramFiles || "C:\\Program Files",
} = {}) {
  if (probe("pg_dump")) return "pg_dump";
  const root = join(programFiles, "PostgreSQL");
  let versions = [];
  try {
    versions = listDir(root);
  } catch {
    return null;
  }
  for (const v of [...versions].sort(compareVersionsDesc)) {
    const candidate = join(root, v, "bin", "pg_dump.exe");
    if (probe(candidate)) return candidate;
  }
  return null;
}
