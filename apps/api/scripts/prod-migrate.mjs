// Apply pending Prisma migrations to the Railway PROD database via the public
// TCP proxy. Run it with `railway run` so the postgres service's variables are
// injected into this process's env (avoids the Windows `railway variables --json`
// TTY bug). Works from ANY cwd — it runs prisma from apps/api itself:
//
//   railway run --service postgres node apps/api/scripts/prod-migrate.mjs   # from repo root
//   # or, equivalently, from apps/api:
//   railway run --service postgres node scripts/prod-migrate.mjs
//
// It builds a proxy DATABASE_URL (password URL-encoded) from the injected vars, prints
// `migrate status`, runs `migrate deploy`, then spawns the read-only `schema-drift.mjs`
// as a post-deploy check and fails closed (nonzero exit) if the live schema still
// differs from prisma/schema.prisma. It never prints the password. This is a permanent
// release step (step 1 of the canonical deploy flow in CLAUDE.md) — not a one-off
// script that is safe to delete after use.
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RAILWAY_PROXY_VARS, redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

// Run prisma from apps/api (this script lives in apps/api/scripts) so the schema +
// prisma.config.ts resolve no matter what CWD the caller invoked us from.
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const e = process.env;

// Fail closed BEFORE resolving so the operator is told exactly which variables to supply.
// The resolve call below fails closed too (`requireProxy: true`): the helper's DATABASE_URL
// fallback is correct for the read-only schema-drift check, but this script WRITES schema and
// must never migrate whatever DATABASE_URL happens to be exported.
const missing = RAILWAY_PROXY_VARS.filter((k) => !e[k]);
if (missing.length) {
  console.error(
    `\nMissing env: ${missing.join(", ")}\n` +
      "Run this via:  railway run --service postgres node scripts/prod-migrate.mjs\n",
  );
  process.exit(1);
}

// Same construction this script has always used — now shared with scripts/schema-drift.mjs.
let url;
try {
  url = resolveDatabaseUrl(e, { requireProxy: true });
} catch (err) {
  console.error(
    `\n${err.message}\n` +
      "Run this via:  railway run --service postgres node scripts/prod-migrate.mjs\n",
  );
  process.exit(1);
}
const env = { ...e, DATABASE_URL: url };
console.log(`Target host: ${redactUrl(url)}`);

const run = (cmd) => execSync(cmd, { stdio: "inherit", env, cwd: apiDir });

console.log("\n=== prisma migrate status ===");
try {
  run("npx prisma migrate status");
} catch {
  // `migrate status` exits non-zero when migrations are pending — that's expected.
}

console.log("\n=== prisma migrate deploy ===");
run("npx prisma migrate deploy");

console.log("\n=== post-deploy schema drift check ===");
const drift = spawnSync(process.execPath, [resolve(apiDir, "scripts", "schema-drift.mjs")], {
  cwd: apiDir,
  env,
  shell: false,
  stdio: "inherit",
});
if (drift.status !== 0) {
  console.error(
    "\npost-deploy drift check FAILED — migrations were APPLIED successfully, but the live " +
      "schema now differs from prisma/schema.prisma; investigate before deploying the app " +
      "(see SQL above)",
  );
  process.exit(drift.status ?? 1);
}

console.log("\n✅ Migration applied.");
