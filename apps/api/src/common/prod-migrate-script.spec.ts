import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// R4 — apps/api/scripts/prod-migrate.mjs contract.
//
// prod-migrate WRITES schema, so it must fail closed when the Railway proxy vars are
// incomplete: the shared helper's DATABASE_URL fallback is correct for schema-drift.mjs
// but must never let `prisma migrate deploy` run against whatever DATABASE_URL happens to
// be exported. These cases drive the real script via spawnSync and assert its observable
// process contract (exit status, stdout/stderr) — no database is touched.

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/prod-migrate.mjs");

const PROXY_VARS = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "RAILWAY_TCP_PROXY_DOMAIN",
  "RAILWAY_TCP_PROXY_PORT",
];

function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

// Windows env vars are case-insensitive, so a copied env may carry `Path` rather than
// `PATH`; adding a second spelling would be ambiguous. Mutate whichever key is present.
function prependToPath(env: NodeJS.ProcessEnv, dir: string): void {
  const key = Object.keys(env).find((k) => /^path$/i.test(k)) ?? "PATH";
  env[key] = `${dir}${path.delimiter}${env[key] ?? ""}`;
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: API_DIR,
    encoding: "utf8",
    env,
    // The drift case lets real prisma exhaust its connect retries against a closed port
    // (~42s measured locally), so this must stay well clear of that. spawnSync blocks the
    // event loop, so jest's own 5s test timer cannot fire against these cases.
    timeout: 180_000,
  });
}

describe("prod-migrate.mjs contract (R4)", () => {
  it("refuses to run when every Railway proxy var is missing, even with DATABASE_URL set", () => {
    const res = run(scrubbedEnv({ DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nope" }));

    // Content oracles first: a missing script would also exit 1.
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).toContain("Missing env:");
    for (const name of PROXY_VARS) {
      expect(res.stderr).toContain(name);
    }
    // The fallback path must not have been taken: no target announced, no deploy attempted.
    expect(res.stdout).not.toContain("Target host");
    expect(res.stdout).not.toContain("migrate deploy");
    expect(res.status).toBe(1);
  });

  it("refuses to run when a single proxy var is missing, naming it", () => {
    const res = run(
      scrubbedEnv({
        DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nope",
        POSTGRES_USER: "u",
        POSTGRES_PASSWORD: "p",
        RAILWAY_TCP_PROXY_DOMAIN: "127.0.0.1",
        RAILWAY_TCP_PROXY_PORT: "1",
      }),
    );

    expect(res.stderr).toContain("Missing env: POSTGRES_DB");
    expect(res.stdout).not.toContain("migrate deploy");
    expect(res.status).toBe(1);
  });

  describe("with all proxy vars present and prisma stubbed out", () => {
    let dir: string;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-migrate-"));
      // `npx prisma migrate …` runs through execSync (a shell), so stub both spellings:
      // POSIX `npx` and Windows `npx.cmd`. Neither touches a database.
      fs.writeFileSync(path.join(dir, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "npx.cmd"), "@exit /b 0\r\n");
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("prints the redacted resolved target and propagates a failing post-deploy drift check", () => {
      const env = scrubbedEnv({
        POSTGRES_USER: "u",
        POSTGRES_PASSWORD: "p w",
        POSTGRES_DB: "d",
        RAILWAY_TCP_PROXY_DOMAIN: "127.0.0.1",
        RAILWAY_TCP_PROXY_PORT: "1",
      });
      prependToPath(env, dir);

      const res = run(env);
      const combined = res.stdout + res.stderr;

      // The target line names the database actually resolved, password redacted.
      expect(res.stdout).toContain("Target host:");
      expect(res.stdout).toContain("***");
      expect(res.stdout).toContain("127.0.0.1:1");
      expect(combined).not.toContain("p w");
      expect(combined).not.toContain("p%20w");

      // The drift step runs after deploy, and its non-zero status is propagated.
      expect(res.stdout).toContain("post-deploy schema drift check");
      expect(res.stderr).toContain("post-deploy drift check FAILED");
      expect(res.stdout).not.toContain("✅ Migration applied.");
      expect(res.status).not.toBe(0);
    });
  });
});
