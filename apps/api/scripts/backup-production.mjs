// Production database backup — replaces backup-production.sh (which needed Git Bash, a
// pg_dump on PATH and `railway run` piping a dump through the shell; none of that is reliable
// on Windows). Run it under `railway run` so the postgres service's variables are injected:
//
//   railway run --service postgres node apps/api/scripts/backup-production.mjs [label]
//
// It reads a dump, never writes to the database. It finds pg_dump (PATH, then the newest
// C:\Program Files\PostgreSQL\<ver>\bin), keeps the password OFF argv (PGPASSWORD only), writes
// backups/production_<ts>_<label>.sql (gitignored; BACKUP_DIR overrides), then REFUSES to bless
// a dump that is not the full prod DB: fewer than 100 tables, no `COPY public._prisma_migrations`
// data, or a truncated file (no pg_dump completion trailer / ends inside a COPY block). A rejected
// dump is renamed *.INVALID so nobody restores from it by mistake.
// Exit: 0 ok · 1 usage/env · 2 dump rejected · pg_dump's own code on failure.
// The flow itself is `runBackup` in ./lib/backup-dump.mjs (injectable, unit-tested).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RAILWAY_PROXY_VARS } from "./lib/railway-db-url.mjs";
import { findPgDump, runBackup } from "./lib/backup-dump.mjs";

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
process.exit(await runBackup({ env: e, label: process.argv[2], pgDump, repoRoot }));
