// Pure helpers behind apps/api/scripts/backup-production.mjs — kept separate so the parts that
// decide "is this dump trustworthy" and "how is pg_dump invoked" are unit-testable without a
// database, a Railway link, or a pg_dump binary.
import {
  createReadStream,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";

/** A prod dump below either floor is not the production database (125+ models, 200+ migrations). */
export const MIN_TABLES = 100;

/** `COPY public._prisma_migrations (...)` — pg_dump emits it unquoted; accept a quoted form too. */
const MIGRATIONS_COPY_RE = /^COPY public\.(?:_prisma_migrations|"_prisma_migrations") /;
const CREATE_TABLE_RE = /^CREATE TABLE public\./;
/** pg_dump ends every COPY data block with a line holding exactly backslash + dot. */
const COPY_TERMINATOR = "\\.";
/** pg_dump's last line of real content. A dump killed mid-write never reaches it. */
const DUMP_TRAILER = "-- PostgreSQL database dump complete";

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
  let inCopy = false; // inside ANY COPY data block — its rows are data, never structure
  let inMigrations = false; // ...and it is the _prisma_migrations block
  let sawTrailer = false;
  let total = 0;
  for await (const raw of lines) {
    total++;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (inCopy) {
      if (line === COPY_TERMINATOR) inCopy = inMigrations = false;
      else if (inMigrations) migrationRows++;
      continue;
    }
    if (line.startsWith(DUMP_TRAILER)) sawTrailer = true;
    else if (CREATE_TABLE_RE.test(line)) tables++;
    else if (line.startsWith("COPY ")) {
      copyBlocks++;
      inCopy = true;
      if (MIGRATIONS_COPY_RE.test(line)) {
        migrationRows = 0;
        inMigrations = true;
      }
    }
  }
  // `unterminated`: the file ended INSIDE a COPY block, so every trailing line was counted as data.
  return {
    lines: total,
    tables,
    copyBlocks,
    migrationRows,
    complete: sawTrailer && !inCopy,
    unterminated: inCopy,
  };
}

/** Why a scan result cannot be trusted as a prod backup — empty array means it can. */
export function dumpProblems(stats) {
  const problems = [];
  if (stats.tables < MIN_TABLES) {
    problems.push(`only ${stats.tables} CREATE TABLE statements (need >= ${MIN_TABLES})`);
  }
  if (stats.unterminated) {
    problems.push("the dump ends inside a COPY data block (truncated)");
  } else if (!stats.complete) {
    problems.push(`no "${DUMP_TRAILER}" trailer (truncated, or still being written)`);
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
  // ProgramW6432 is the 64-bit Program Files even from a 32-bit Node (where ProgramFiles points at
  // "Program Files (x86)"); pg_dump installs live in the 64-bit one.
  programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files",
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

/**
 * The whole backup flow behind a seam: `spawn`, `log` and `err` are injectable so the safety paths
 * (pg_dump failure cleans up, a rejected dump is renamed `.INVALID`, exit codes) are testable with
 * a fake pg_dump and no database. Returns the process exit code — 0 verified, 2 rejected, or
 * pg_dump's own non-zero code (1 when it never ran).
 */
export async function runBackup({
  env,
  label,
  pgDump,
  repoRoot,
  spawn = spawnSync,
  log = console.log,
  err = console.error,
  now = new Date(),
}) {
  const dir = env.BACKUP_DIR ? resolve(env.BACKUP_DIR) : resolve(repoRoot, "backups");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, backupFileName(label, now));

  log(`Target: ${env.RAILWAY_TCP_PROXY_DOMAIN}:${env.RAILWAY_TCP_PROXY_PORT}/${env.POSTGRES_DB}`);
  log(`Tool:   ${pgDump}`);
  log(`File:   ${file}`);

  const inv = buildPgDumpInvocation(env, file);
  const r = spawn(pgDump, inv.args, { stdio: "inherit", env: inv.env });
  if (r.error || r.status !== 0) {
    err(
      `\npg_dump failed (${r.error?.message ?? r.status ?? r.signal}) — NO usable backup written`,
    );
    try {
      unlinkSync(file); // a partial dump is worse than none
    } catch {
      // nothing was written
    }
    return r.status || 1;
  }

  const stats = await scanDump(
    createInterface({ input: createReadStream(file), crlfDelay: Infinity }),
  );
  const mb = (statSync(file).size / 1048576).toFixed(1);
  log(
    `\nBackup written: ${mb} MB · ${stats.lines} lines · ${stats.tables} tables · ` +
      `${stats.copyBlocks} COPY blocks · _prisma_migrations rows: ${stats.migrationRows}`,
  );

  const problems = dumpProblems(stats);
  if (problems.length) {
    const rejected = `${file}.INVALID`;
    renameSync(file, rejected);
    err(`\nREJECTED — this is not the full production dump:\n  - ${problems.join("\n  - ")}`);
    err(`Renamed to ${rejected}. Do NOT rely on it.`);
    return 2;
  }
  log(`OK — verified backup: ${file}`);
  log(`Restore with:  psql < "${file}"  (against a scratch DB first)`);
  return 0;
}
