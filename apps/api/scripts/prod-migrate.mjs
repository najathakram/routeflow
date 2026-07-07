// Apply pending Prisma migrations to the Railway PROD database via the public
// TCP proxy. Run it with `railway run` so the postgres service's variables are
// injected into this process's env (avoids the Windows `railway variables --json`
// TTY bug):
//
//   cd apps/api
//   railway run --service postgres node scripts/prod-migrate.mjs
//
// It builds a proxy DATABASE_URL (password URL-encoded) from the injected vars,
// prints `migrate status`, then runs `migrate deploy`. It never prints the
// password. Safe to delete after use.
import { execSync } from "node:child_process";

const e = process.env;
const need = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "RAILWAY_TCP_PROXY_DOMAIN",
  "RAILWAY_TCP_PROXY_PORT",
];
const missing = need.filter((k) => !e[k]);
if (missing.length) {
  console.error(
    `\nMissing env: ${missing.join(", ")}\n` +
      "Run this via:  railway run --service postgres node scripts/prod-migrate.mjs\n",
  );
  process.exit(1);
}

const url =
  `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
  `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`;
const env = { ...e, DATABASE_URL: url };
console.log(`Target host: ${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}`);

const run = (cmd) => execSync(cmd, { stdio: "inherit", env });

console.log("\n=== prisma migrate status ===");
try {
  run("npx prisma migrate status");
} catch {
  // `migrate status` exits non-zero when migrations are pending — that's expected.
}

console.log("\n=== prisma migrate deploy ===");
run("npx prisma migrate deploy");

console.log("\n✅ Migration applied.");
