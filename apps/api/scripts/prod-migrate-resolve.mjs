// Mark ONE failed Prisma migration as rolled back on the Railway PROD database (W-1275, SA-1194 K2).
// A failed `migrate deploy` leaves a failed row in _prisma_migrations that blocks the next deploy;
// this is the one reviewed way out (replaces a hand-typed `prisma migrate resolve` on a hand-built
// proxy URL). Run it under `railway run`, ONLY on an owner yes, once per failed folder:
//
//   railway run --service postgres node apps/api/scripts/prod-migrate-resolve.mjs <folder>
//
// It reuses resolveDatabaseUrl(requireProxy) (no second URL builder), allows --rolled-back only
// (never --applied), refuses unless <folder> exists under prisma/migrations AND is the single
// migration `migrate status` reports as failed, and prints status before and after with the URL
// redacted. It runs no deploy, reset or push.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { redactUrl, resolveDatabaseUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const die = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

const args = process.argv.slice(2).filter((a) => a !== "--rolled-back");
if (args.includes("--applied"))
  die("Refused: --applied is never allowed; this script only marks a migration rolled back.");
if (args.length !== 1)
  die(
    "Usage: node scripts/prod-migrate-resolve.mjs [--rolled-back] <migration-folder> (exactly one folder)",
  );
const folder = args[0];
if (!/^[0-9]{14}_[a-z0-9_]+$/.test(folder))
  die(
    `Refused: folder "${folder}" is not a migration folder name (14 digits, _, lowercase words).`,
  );
if (!existsSync(resolve(apiDir, "prisma", "migrations", folder, "migration.sql"))) {
  die(`Refused: ${folder} is not under prisma/migrations.`);
}

let url;
try {
  url = resolveDatabaseUrl(process.env, { requireProxy: true });
} catch (err) {
  die(
    `${err.message}\nRun this via:  railway run --service postgres node scripts/prod-migrate-resolve.mjs <folder>`,
  );
}
const env = { ...process.env, DATABASE_URL: url };
console.log(`Target host: ${redactUrl(url)}`);

// Prisma is called with an argv list. Windows needs a shell for npx.cmd; every token is a constant
// or the folder validated against the regex above, so nothing can inject.
const prisma = (...argv) => {
  const win = process.platform === "win32";
  const r = win
    ? spawnSync(["npx.cmd", "prisma", ...argv].join(" "), {
        cwd: apiDir,
        env,
        encoding: "utf8",
        shell: true,
      })
    : spawnSync("npx", ["prisma", ...argv], { cwd: apiDir, env, encoding: "utf8" });
  const text = scrubSecrets(`${r.stdout ?? ""}${r.stderr ?? ""}`, url);
  return { text, status: r.status ?? 1 };
};
const show = (title, text) => console.log(`\n=== ${title} ===\n${text}`);

// Prisma prints this block on stderr (console.error) with exit 1:
//   "Following migration have failed:" / "Following migrations have failed:" then one name per line.
const failedNames = (text) => {
  const m = /Following migrations? have failed:\r?\n([\s\S]*?)(?:\r?\n\s*\r?\n|$)/.exec(text);
  return m
    ? m[1]
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
};

const before = prisma("migrate", "status");
show("prisma migrate status (before)", before.text);
const failed = failedNames(before.text);
if (failed.length === 0)
  die("Refused: migrate status reports no failed migration; nothing to resolve.");
if (failed.length !== 1 || failed[0] !== folder) {
  die(
    `Refused: ${folder} is not the one failed migration. Status reports failed: ${failed.join(", ")}`,
  );
}

const done = prisma("migrate", "resolve", "--rolled-back", folder);
show(`prisma migrate resolve --rolled-back ${folder}`, done.text);
if (done.status !== 0) die(`migrate resolve failed (exit ${done.status}).`);

show("prisma migrate status (after)", prisma("migrate", "status").text);
console.log(`\n✅ ${folder} marked rolled back. Re-run prod-migrate.mjs to apply it.`);
