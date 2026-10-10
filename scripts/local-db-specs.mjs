#!/usr/bin/env node
// `npm run local:test:db` (#2183): the DB-backed spec lane on its OWN fresh database.
//
// WHY: the lane used to run against the shared compose database (`routeflow_dev`), the same one
// the compose api container serves, with its crons running. F2's only recorded
// order-number.db.spec red was a Prisma "Unable to start a transaction in the given time" on that
// shared database while the live api was attached; it never reproduced on an isolated database.
// A spec lane must not share its database with anything, so this script:
//   1. creates a uniquely named database `rf_dbspec_<time>_<pid>` on the local compose Postgres,
//   2. applies every migration to it (`prisma migrate deploy`, the same path prod uses),
//   3. runs the command after `--` with the compose connection pointed at it and RUN_DB_SPECS=local,
//   4. drops it again: on success, on failure, and after Ctrl-C.
// It only ever creates or drops a name matching SPEC_DB_PATTERN, so `routeflow_dev` (or any other
// database) can never be the target of either statement. Arguments are validated before anything
// is created. A crashed run can leave an `rf_dbspec_*` database behind; `--keep` does that on
// purpose (for debugging) and prints the name.
//
// Usage: node scripts/local-db-specs.mjs [--keep] -- "<command string>"
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(REPO_ROOT, "apps", "api");
const TAG = "local-db-specs";

/** The only database names this script will ever create or drop. */
export const SPEC_DB_PATTERN = /^rf_dbspec_[a-z0-9]{1,16}_[0-9]{1,10}$/;

/** A fresh, unique spec-database name. */
export function specDbName(now = Date.now(), pid = process.pid) {
  return `rf_dbspec_${now.toString(36)}_${pid}`;
}

/** Throws unless `name` is one of this script's own spec databases. */
export function assertSpecDbName(name) {
  if (typeof name !== "string" || !SPEC_DB_PATTERN.test(name)) {
    throw new Error(
      `refusing database "${name}": this lane only creates and drops its own rf_dbspec_* databases`,
    );
  }
  return name;
}

/**
 * The compose connection (same POSTGRES_USER / POSTGRES_PASSWORD defaults as docker-compose.yml and
 * scripts/local-env.mjs), always on localhost:5432. `database` is the spec database, or the
 * compose maintenance database `postgres` for CREATE/DROP.
 */
export function composeConnection(env, database) {
  return {
    host: "localhost",
    port: 5432,
    user: env.POSTGRES_USER || "user",
    password: env.POSTGRES_PASSWORD || "pass",
    database,
  };
}

export function connectionUrl({ host, port, user, password, database }) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

/** Parses the CLI. Returns { help } or { keep, command }; throws on anything it doesn't know. */
export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const sep = argv.indexOf("--");
  if (sep === -1 || argv.length <= sep + 1) throw new Error('expected `-- "<command string>"`');
  const flags = argv.slice(0, sep);
  const unknown = flags.filter((f) => f !== "--keep");
  if (unknown.length) throw new Error(`unknown flag(s): ${unknown.join(", ")}`);
  return { keep: flags.includes("--keep"), command: argv.slice(sep + 1).join(" ") };
}

const HELP = `${TAG}.mjs — run the DB spec lane on its own fresh database

Usage: node scripts/local-db-specs.mjs [--keep] -- "<command string>"

Creates rf_dbspec_<time>_<pid> on the local compose Postgres (localhost:5432, POSTGRES_USER /
POSTGRES_PASSWORD as in docker-compose.yml), applies every migration, runs the command with the
compose connection pointed at it and RUN_DB_SPECS=local, then drops it (also on failure or Ctrl-C).
Any RAILWAY_* variable is removed from the command's environment.

  --keep   leave the database in place afterwards and print its name
  --help   print this help and exit 0
`;

async function withAdmin(env, fn) {
  const pg = createRequire(path.join(API_DIR, "package.json"))("pg");
  const client = new pg.Client({ ...composeConnection(env, "postgres"), ssl: false });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${TAG}: ${e.message} — see --help`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const name = assertSpecDbName(specDbName());
  try {
    await withAdmin(process.env, (c) => c.query(`CREATE DATABASE "${name}"`));
  } catch (e) {
    console.error(`${TAG}: could not create ${name} on localhost:5432: ${e.message}`);
    console.error(`${TAG}: is the compose Postgres up? (npm run db:up)`);
    return 2;
  }
  console.log(`${TAG}: created ${name}`);

  // Ctrl-C reaches the child too; spawnSync defers this handler until the child has exited, so
  // the drop below still runs.
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let status = 1;
  try {
    const env = { ...process.env };
    // As in local-env.mjs --db: a `railway run`-tainted shell must never redirect this at production.
    for (const key of Object.keys(env)) if (key.startsWith("RAILWAY_")) delete env[key];
    env.DATABASE_URL = connectionUrl(composeConnection(process.env, name));
    env.RUN_DB_SPECS = "local";

    const migrate = spawnSync("npx prisma migrate deploy", {
      cwd: API_DIR,
      shell: true,
      stdio: "inherit",
      env,
    });
    if (migrate.status !== 0 || interrupted) {
      console.error(`${TAG}: migrate deploy failed on ${name}; not running the specs`);
      status = migrate.status || 1;
    } else {
      const run = spawnSync(opts.command, { shell: true, stdio: "inherit", env });
      if (run.error) console.error(`${TAG}: ${run.error.message}`);
      status = run.status ?? 1;
    }
  } finally {
    if (opts.keep) {
      console.log(`${TAG}: --keep: left ${name} in place`);
    } else {
      try {
        await withAdmin(process.env, (c) =>
          c.query(`DROP DATABASE IF EXISTS "${assertSpecDbName(name)}" WITH (FORCE)`),
        );
        console.log(`${TAG}: dropped ${name}`);
      } catch (e) {
        console.error(`${TAG}: could not drop ${name}: ${e.message} (drop it by hand)`);
        if (status === 0) status = 1;
      }
    }
  }
  return interrupted ? 130 : status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`${TAG}: ${e.message}`);
      process.exit(1);
    },
  );
}
