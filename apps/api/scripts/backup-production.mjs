// Production database backup — replaces backup-production.sh (which needed Git Bash, a
// pg_dump on PATH and `railway run` piping a dump through the shell; none of that is reliable
// on Windows). Run it under `railway run` so the postgres service's variables are injected:
//
//   railway run --service postgres node apps/api/scripts/backup-production.mjs [label]
//
// It reads a dump, never writes to the database. It finds pg_dump (PATH, then the newest
// C:\Program Files\PostgreSQL\<ver>\bin), keeps the password OFF argv (PGPASSWORD only), writes
// backups/production_<ts>_<label>.sql (gitignored; BACKUP_DIR overrides), then REFUSES to bless
// a dump that is not the full prod DB: fewer than 100 tables, or no
// `COPY public._prisma_migrations` block. A rejected dump is renamed *.INVALID so nobody restores
// from it by mistake. Exit: 0 ok · 1 usage/env · 2 dump rejected · pg_dump's own code on failure.
import { spawnSync } from "node:child_process";
import { createReadStream, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RAILWAY_PROXY_VARS } from "./lib/railway-db-url.mjs";
import {
  backupFileName,
  buildPgDumpInvocation,
  dumpProblems,
  findPgDump,
  scanDump,
} from "./lib/backup-dump.mjs";

const e = process.env;
const self = "apps/api/scripts/backup-production.mjs";

const missing = RAILWAY_PROXY_VARS.filter((k) => !e[k]);
if (missing.length) {
  console.error(
    `\nMissing env: ${missing.join(", ")}\n` +
      `Run this via:  railway run --service postgres node ${self} [label]\n`,
  );
  process.exit(1);
}

const pgDump = findPgDump();
if (!pgDump) {
  console.error(
    "\npg_dump not found on PATH or under C:\\Program Files\\PostgreSQL\\<version>\\bin.\n" +
      "Install the PostgreSQL client tools (a version >= the server's major) and retry.\n",
  );
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = e.BACKUP_DIR ? resolve(e.BACKUP_DIR) : resolve(repoRoot, "backups");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, backupFileName(process.argv[2]));

console.log(`Target: ${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`);
console.log(`Tool:   ${pgDump}`);
console.log(`File:   ${file}`);

const inv = buildPgDumpInvocation(e, file);
const r = spawnSync(pgDump, inv.args, { stdio: "inherit", env: inv.env });
if (r.error || r.status !== 0) {
  console.error(
    `\npg_dump failed (${r.error?.message ?? r.status ?? r.signal}) — NO usable backup written`,
  );
  try {
    unlinkSync(file); // a partial dump is worse than none
  } catch {
    // nothing was written
  }
  process.exit(r.status || 1);
}

const stats = await scanDump(
  createInterface({ input: createReadStream(file), crlfDelay: Infinity }),
);
const mb = (statSync(file).size / 1048576).toFixed(1);
console.log(
  `\nBackup written: ${mb} MB · ${stats.lines} lines · ${stats.tables} tables · ` +
    `${stats.copyBlocks} COPY blocks · _prisma_migrations rows: ${stats.migrationRows}`,
);

const problems = dumpProblems(stats);
if (problems.length) {
  const rejected = `${file}.INVALID`;
  renameSync(file, rejected);
  console.error(
    `\nREJECTED — this is not the full production dump:\n  - ${problems.join("\n  - ")}`,
  );
  console.error(`Renamed to ${rejected}. Do NOT rely on it.`);
  process.exit(2);
}
console.log(`OK — verified backup: ${file}`);
console.log(`Restore with:  psql < "${file}"  (against a scratch DB first)`);
