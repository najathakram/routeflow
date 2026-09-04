#!/usr/bin/env node
// Read-only schema drift check. Exit 0 = no drift, 2 = drift (SQL printed), 1 = error.
//
// DATABASE_URL resolution: the Railway proxy vars (POSTGRES_USER, POSTGRES_PASSWORD,
// POSTGRES_DB, RAILWAY_TCP_PROXY_DOMAIN, RAILWAY_TCP_PROXY_PORT) win over a plain
// DATABASE_URL, since under `railway run --service postgres` DATABASE_URL is the
// unreachable *.railway.internal host. See scripts/lib/railway-db-url.mjs.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

const HELP = `schema-drift.mjs — read-only Prisma schema drift check

Usage: node scripts/schema-drift.mjs [--local] [--dry-run] [--help]

Flags:
  --local     Resolve the target from DATABASE_URL ONLY (Railway proxy variables are
              ignored entirely) and refuse any host other than localhost, 127.0.0.1,
              ::1, postgres or db — exit 1 naming the host. Use this for the compose
              stack so an exported \`railway run\` environment can never point a local
              check at production.
  --dry-run   Print the resolved (redacted) target and the prisma commands that would
              run, without spawning prisma or touching the database.
  --help      Print this help and exit 0.

DATABASE_URL resolution (Railway proxy vars win over DATABASE_URL):
  POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, RAILWAY_TCP_PROXY_DOMAIN,
  RAILWAY_TCP_PROXY_PORT — if all are set, they build the target URL.
  Otherwise DATABASE_URL is used if set.
  Otherwise the script exits 1 naming the missing variables.
  With --local none of the above applies: DATABASE_URL is the only source.

Test hook:
  SCHEMA_DRIFT_PRISMA_CLI — path to a stand-in prisma CLI, honoured ONLY inside a jest
  worker (JEST_WORKER_ID set) that also sets this variable; a WARNING line is printed
  whenever it is used. Anywhere else it is ignored and the real prisma CLI runs.

Exit codes:
  0   no drift — database matches prisma/schema.prisma
  2   drift detected — the missing/extra SQL is printed
  1   error — missing env, or \`migrate diff\` could not complete (unreachable database
      or CLI error). A pending/diverged \`migrate status\` is informational, not fatal.
`;

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// Argument parsing runs BEFORE prisma is resolved below: --help must work even when
// prisma isn't installed (require.resolve would otherwise throw first), and it must
// never print the SCHEMA_DRIFT_PRISMA_CLI notice — that notice belongs to an actual
// drift-check run, not to a plain --help.
const argvFlags = new Set(process.argv.slice(2));
if (argvFlags.has("--help")) {
  console.log(HELP);
  process.exit(0);
}
const dryRun = argvFlags.has("--dry-run");
const localOnly = argvFlags.has("--local");

// SCHEMA_DRIFT_PRISMA_CLI is a test-only override so the exit-code contract can be
// exercised without a database. It is honoured ONLY inside a jest worker that also sets the
// override; anywhere else it is ignored (loudly) so a stray export can never turn the gate into
// a stub that reports NO DRIFT. NODE_ENV is deliberately NOT part of this guard: CI's
// db-migrations job sets `NODE_ENV: test` at job level, which would arm the stub at the one
// place the gate actually runs.
const override = process.env.SCHEMA_DRIFT_PRISMA_CLI;
const underTest = Boolean(process.env.JEST_WORKER_ID) && Boolean(override);
const prismaCli = underTest
  ? override
  : require.resolve("prisma/build/index.js", { paths: [apiRoot] });
if (underTest) {
  console.error(
    "schema-drift: WARNING — SCHEMA_DRIFT_PRISMA_CLI override in effect; this is NOT a real drift check",
  );
} else if (override) {
  console.error(
    "schema-drift: SCHEMA_DRIFT_PRISMA_CLI is ignored outside test (JEST_WORKER_ID unset); " +
      "using the real prisma CLI",
  );
}

// --local exists because a shell that has run `railway run` keeps POSTGRES_*/RAILWAY_TCP_PROXY_*
// exported: the normal resolution order would then silently diff PRODUCTION from a local command.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

let url;
if (localOnly) {
  url = process.env.DATABASE_URL;
  if (!url) {
    console.error("schema-drift: --local requires DATABASE_URL to be set (Railway vars ignored)");
    process.exit(1);
  }
  let host;
  try {
    // WHATWG URL brackets IPv6 hosts ("[::1]"); strip them before the lookup.
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    console.error("schema-drift: --local could not parse DATABASE_URL as a URL");
    process.exit(1);
  }
  if (!LOCAL_HOSTS.has(host)) {
    console.error(
      `schema-drift: --local refuses non-local database host ${host} — ` +
        `allowed hosts are ${[...LOCAL_HOSTS].join(", ")}`,
    );
    process.exit(1);
  }
} else {
  try {
    url = resolveDatabaseUrl(process.env);
  } catch (e) {
    console.error(`schema-drift: ${e.message}`);
    process.exit(1);
  }
}
console.log(`schema-drift: target ${redactUrl(url)}`);

const STATUS = ["migrate", "status"];
const DIFF = [
  "migrate",
  "diff",
  "--from-config-datasource",
  "--to-schema",
  "prisma/schema.prisma",
  "--script",
  "--exit-code",
];

// A verdict is only ever printed for a prisma run that actually happened: --dry-run lists the
// argv it would spawn and stops here, so it can never assert "NO DRIFT" for an unchecked database.
if (dryRun) {
  // The resolved CLI path is printed verbatim so a dry run also proves WHICH prisma would
  // run — that is the anti-masquerade oracle for the SCHEMA_DRIFT_PRISMA_CLI override.
  for (const args of [STATUS, DIFF]) {
    console.log(`[dry-run] node ${prismaCli} ${args.join(" ")}`);
  }
  process.exit(0);
}

function run(args) {
  const r = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: apiRoot,
    shell: false,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
  });
  if (r.stdout) process.stdout.write(scrubSecrets(r.stdout, url));
  if (r.stderr) process.stderr.write(scrubSecrets(r.stderr, url));
  return r;
}

// `migrate status` is informational only: it exits non-zero for benign states (pending
// migrations, or a history that diverged when prod was baselined). The drift verdict comes
// from `migrate diff --exit-code` alone.
const status = run(STATUS);
if (status.status !== 0) {
  console.warn(
    `schema-drift: migrate status exited ${status.status} — pending or diverged migration ` +
      "history is informational here; the drift verdict comes from migrate diff",
  );
}

const diff = run(DIFF);
if (diff.status === 0) {
  console.log("schema-drift: NO DRIFT — database matches prisma/schema.prisma");
  process.exit(0);
}
if (diff.status === 2) {
  console.error(
    "schema-drift: DRIFT DETECTED — SQL above shows what the database is missing/extra",
  );
  process.exit(2);
}
console.error(
  `schema-drift: prisma migrate diff exited ${diff.status} — check could not complete ` +
    "(database unreachable or CLI error)",
);
process.exit(1);
