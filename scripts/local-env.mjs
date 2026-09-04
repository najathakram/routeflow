#!/usr/bin/env node
// Cross-shell environment wrapper for the root `local:*` scripts.
//
// WHY: npm runs package scripts through the platform shell — cmd.exe on Windows unless
// `script-shell` is configured. The POSIX `VAR="x" sh -c '…'` prefix form therefore fails
// there with "'DATABASE_URL' is not recognized as an internal or external command", which
// broke every local:* gate on a Windows checkout. This script sets the variables in Node and
// hands the command to the platform shell, so the same package.json line works on both.
//
// Usage: node scripts/local-env.mjs [--db] [--smoke] [--db-specs] [--e2e] -- "<command string>"
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, computed from this file's own location — used to build an ABSOLUTE
// PLAYWRIGHT_JSON_OUTPUT_FILE below so the result doesn't depend on the child's cwd
// (Playwright resolves that env var relative to process.cwd(), not the config file's
// directory — see the comment at its use site).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `local-env.mjs — run a command with the local compose environment applied

Usage: node scripts/local-env.mjs [flags] -- "<command string>"

Flags:
  --db         DATABASE_URL for the compose Postgres on localhost:5432, using the same
               POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB defaults as docker-compose.yml
               (user / pass / routeflow_dev). Any inherited Railway proxy variables are
               REMOVED from the child environment so a \`railway run\`-tainted shell can
               never redirect a local command at production.
  --smoke      SMOKE_BASE_URL=http://localhost:3000, SMOKE_TENANT_SLUG=test,
               SMOKE_WAIT_RETRIES=30.
  --db-specs   RUN_DB_SPECS=local.
  --e2e        Local Playwright E2E lane vars: PLAYWRIGHT_BASE_URL=http://localhost:3001,
               SMOKE_BASE_URL=http://localhost:3000, PLAYWRIGHT_TENANT_SLUG=e2e-routeflow,
               E2E_SEED_DATABASE_URL=<the compose Postgres URL, same POSTGRES_USER/
               POSTGRES_PASSWORD/POSTGRES_DB defaults as --db>, PLAYWRIGHT_JSON_OUTPUT_FILE=
               <repo-root>/.campaign/runs/web-e2e-local.json (an absolute path — keeps the
               local run out of web-e2e.json, which scripts/campaign-check.mjs reads as
               campaign evidence).
  --help       Print this help and exit 0.

Everything after \`--\` is one command string, run through the platform shell (so \`&&\`
chains work under both cmd.exe and sh). The child's exit status is this script's status.
`;

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const sep = argv.indexOf("--");
if (sep === -1 || argv.length <= sep + 1) {
  console.error('local-env: expected `-- "<command string>"` — see --help');
  process.exit(1);
}
const flags = new Set(argv.slice(0, sep));
const command = argv.slice(sep + 1).join(" ");

const unknown = [...flags].filter((f) => !["--db", "--smoke", "--db-specs", "--e2e"].includes(f));
if (unknown.length) {
  console.error(`local-env: unknown flag(s): ${unknown.join(", ")} — see --help`);
  process.exit(1);
}

const env = { ...process.env };

if (flags.has("--db")) {
  // The Railway proxy variables win over DATABASE_URL in scripts/lib/railway-db-url.mjs, so a
  // shell that has run `railway run --service postgres` would otherwise point a local command
  // at the production database. Strip them before the child ever sees them.
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_")) delete env[key];
  }
  // `||` not `??`, to match docker-compose.yml's `${POSTGRES_USER:-user}`: an exported-but-empty
  // variable falls back to the default there too.
  const user = process.env.POSTGRES_USER || "user";
  const password = process.env.POSTGRES_PASSWORD || "pass";
  const database = process.env.POSTGRES_DB || "routeflow_dev";
  env.DATABASE_URL = `postgresql://${user}:${password}@localhost:5432/${database}`;
  // POSTGRES_* are kept (the compose defaults above are derived from them), but the proxy
  // pair they pair with is gone, so the proxy branch can no longer trigger.
}

if (flags.has("--smoke")) {
  env.SMOKE_BASE_URL = "http://localhost:3000";
  env.SMOKE_TENANT_SLUG = "test";
  env.SMOKE_WAIT_RETRIES = "30";
}

if (flags.has("--db-specs")) {
  env.RUN_DB_SPECS = "local";
}

if (flags.has("--e2e")) {
  // Same POSTGRES_USER/PASSWORD/DB defaults as --db, kept independent so a caller can pass
  // --e2e without --db (E2E_SEED_DATABASE_URL is a distinct var name from DATABASE_URL — see
  // apps/web/e2e/setup/global.setup.ts).
  const user = process.env.POSTGRES_USER || "user";
  const password = process.env.POSTGRES_PASSWORD || "pass";
  const database = process.env.POSTGRES_DB || "routeflow_dev";
  env.PLAYWRIGHT_BASE_URL = "http://localhost:3001";
  env.SMOKE_BASE_URL = "http://localhost:3000";
  env.PLAYWRIGHT_TENANT_SLUG = "e2e-routeflow";
  env.E2E_SEED_DATABASE_URL = `postgresql://${user}:${password}@localhost:5432/${database}`;
  // playwright.config.ts hardcodes `outputFile: "../../.campaign/runs/web-e2e.json"` (matches
  // master — never read PLAYWRIGHT_JSON_OUTPUT_NAME, that var only feeds the OUTPUT_DIR/
  // OUTPUT_NAME fallback path for a reporter's output *directory*, not its file). The var that
  // actually redirects the JSON reporter's file is PLAYWRIGHT_JSON_OUTPUT_FILE, and
  // resolveOutputFile() in node_modules/playwright/lib/runner/index.js checks it BEFORE the
  // config's `outputFile` (line 1520 `resolveFromEnv('PLAYWRIGHT_JSON_OUTPUT_FILE')` runs first;
  // line 1521 only falls back to `options.outputFile` when that env var is unset) — so setting
  // it here does override the config without touching master's hardcoded value. resolveFromEnv
  // resolves relative to process.cwd() (line 1515), not the config file's directory, so this is
  // an ABSOLUTE path computed from REPO_ROOT above rather than a "../../"-relative one.
  env.PLAYWRIGHT_JSON_OUTPUT_FILE = path.join(REPO_ROOT, ".campaign", "runs", "web-e2e-local.json");
  delete env.CI;
}

const res = spawnSync(command, { shell: true, stdio: "inherit", env });
if (res.error) {
  console.error(`local-env: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
