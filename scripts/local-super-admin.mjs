// D-03 (#1803): a LOCAL-ONLY, throwaway super-admin for the local Playwright lane, so the super-admin specs
// (e.g. 52-platform-admin-mobile-overflow, the rules-lift flow) can run against the docker-compose stack
// instead of falling back to a post-deploy click-through.
//
// SCOPE (owner-approved 2026-09-25: local-only throwaway accounts and NOTHING else):
//   * refuses any database that is not provably local (`isLocalDbTarget`, an allowlist: localhost / loopback /
//     the compose `postgres` host). There is NO override flag. A Railway proxy host is never local.
//   * mints ONE user, `local-sa` (role SUPER_ADMIN), with a RANDOM password generated per run (never fixed,
//     never in git, never printed, never passed on a command line). Re-running rotates it.
//   * writes the credentials to `local-assets/local-sa.env` (gitignored) with mode 0600, and nothing else.
//     `scripts/local-env.mjs --e2e` reads that file into the Playwright child's environment as
//     PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD. No agent needs to read it.
//   * touches no other user: an existing `local-sa` that is NOT a SUPER_ADMIN is refused, never overwritten.
//   * adds NO API path and NO prod capability.
//
//   npm run local:sa            # mint / rotate, then `npm run local:e2e` picks it up
//   node scripts/local-super-admin.mjs --self-test
//
// Exit: 0 ok · 1 refused (nothing written) · 2 env/connection error.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isLocalDbTarget } from "../apps/api/scripts/lib/local-db-target.cjs";
import { redactUrl, resolveDatabaseUrl } from "../apps/api/scripts/lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const TAG = "local-super-admin";
export const SA_USERNAME = "local-sa";
const SA_EMAIL = "local-sa@routeflow.invalid";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SA_ENV_FILE = resolve(REPO_ROOT, "local-assets", "local-sa.env");

const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

/** Throws unless the URL is provably local. Pure. */
export function assertLocalTarget(url) {
  if (!isLocalDbTarget(url)) {
    throw refuse(
      `refusing: ${url ? redactUrl(url) : "no database URL"} is not a provably local database (localhost, loopback or the compose 'postgres' host only; there is no override)`,
    );
  }
}

/** A fresh random password: 24 url-safe chars from 18 random bytes. Pure apart from the RNG. */
export function newPassword() {
  return randomBytes(18).toString("base64url");
}

/** The env-file text. Exactly the two variables the Playwright lane reads. */
export function renderEnvFile(password) {
  return `PLAYWRIGHT_SA_USERNAME=${SA_USERNAME}\nPLAYWRIGHT_SA_PASSWORD=${password}\n`;
}

/** Write the file 0600 (created 0600, and re-chmod'd in case it already existed with looser bits). */
export function writeEnvFile(file, password) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderEnvFile(password), { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function main() {
  // The shared resolver only (B768): it never names the connection variable here. `local-env.mjs --db` has
  // already stripped every RAILWAY_* variable and set the compose URL.
  let url;
  try {
    url = resolveDatabaseUrl(process.env, { requireProxy: false });
    assertLocalTarget(url);
  } catch (e) {
    console.error(`${TAG}: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  }
  const pg = require("pg");
  const bcrypt = require("bcrypt");
  const password = newPassword();
  const hash = await bcrypt.hash(password, 10);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const existing = (
      await client.query('SELECT id, role::text AS role FROM "User" WHERE username = $1', [
        SA_USERNAME,
      ])
    ).rows[0];
    if (existing && existing.role !== "SUPER_ADMIN") {
      throw refuse(`user '${SA_USERNAME}' exists with role ${existing.role}; refusing to touch it`);
    }
    if (existing) {
      await client.query(
        'UPDATE "User" SET password = $1, "forcePasswordChange" = false, status = \'ACTIVE\', "updatedAt" = NOW() WHERE id = $2',
        [hash, existing.id],
      );
    } else {
      await client.query(
        `INSERT INTO "User" (id, username, email, password, role, status, "forcePasswordChange", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'SUPER_ADMIN', 'ACTIVE', false, NOW(), NOW())`,
        [SA_USERNAME, SA_EMAIL, hash],
      );
    }
    writeEnvFile(SA_ENV_FILE, password); // written before COMMIT: a failed write rolls the user back
    await client.query("COMMIT");
    console.log(
      `${TAG}: ${existing ? "rotated" : "created"} '${SA_USERNAME}' on ${redactUrl(url)}; credentials in local-assets/local-sa.env (mode 600, gitignored, not printed)`,
    );
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** --self-test: the pure guards and the file writer, no database. */
async function selfTest() {
  const { mkdtempSync, readFileSync, statSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  let failed = 0;
  const check = (name, ok) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  };
  const refused = (url) => {
    try {
      assertLocalTarget(url);
      return false;
    } catch (e) {
      return e.refuse === true;
    }
  };
  for (const bad of [
    "postgresql://u:p@monorail.proxy.rlwy.net:5432/railway",
    "postgresql://u:p@postgres.railway.internal:5432/railway",
    "postgresql://u:p@db.example.com:5432/x",
    "",
    undefined,
    "not a url",
  ])
    check(`refuses ${JSON.stringify(bad)}`, refused(bad));
  for (const good of [
    "postgresql://u:p@localhost:5432/routeflow_dev",
    "postgresql://u:p@127.0.0.1:55432/x",
    "postgresql://u:p@[::1]:5432/x",
    "postgresql://u:p@postgres:5432/x",
  ])
    check(`allows ${good.split("@")[1]}`, !refused(good));
  const a = newPassword();
  const b = newPassword();
  check("passwords are random per call and long enough", a !== b && a.length >= 24);
  const dir = mkdtempSync(join(tmpdir(), "lsa-"));
  const file = join(dir, "sub", "local-sa.env");
  writeEnvFile(file, a);
  check("file is mode 0600", (statSync(file).mode & 0o777) === 0o600);
  check(
    "file holds exactly the two variables",
    readFileSync(file, "utf8") ===
      `PLAYWRIGHT_SA_USERNAME=${SA_USERNAME}\nPLAYWRIGHT_SA_PASSWORD=${a}\n`,
  );
  writeEnvFile(file, b);
  check("rewriting keeps mode 0600", (statSync(file).mode & 0o777) === 0o600);
  rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${TAG} self-test: ${failed} FAILED` : `${TAG} self-test: all passed`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = process.argv.includes("--self-test") ? await selfTest() : await main();
}
