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
    timeout: 30_000,
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
    let fakePrisma: string;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-migrate-"));
      // `npx prisma migrate …` runs through execSync (a shell), so stub both spellings:
      // POSIX `npx` and Windows `npx.cmd`. Neither touches a database.
      fs.writeFileSync(path.join(dir, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "npx.cmd"), "@exit /b 0\r\n");
      // The post-deploy drift step spawns scripts/schema-drift.mjs, which honours the same
      // SCHEMA_DRIFT_PRISMA_CLI + JEST_WORKER_ID test hook covered exhaustively in
      // schema-drift-script.spec.ts (T3(d)/T3(h)). Stubbing it here proves prod-migrate.mjs's
      // OWN exit-code mapping (drift's nonzero status is propagated as prod-migrate's own
      // status) without letting real prisma exhaust its connect retries against a dead port
      // (~40s measured locally).
      fakePrisma = path.join(dir, "fake-prisma.mjs");
      fs.writeFileSync(
        fakePrisma,
        [
          "const argv = process.argv.slice(2);",
          "const isStatus = argv.includes('status');",
          "const raw = isStatus ? process.env.FAKE_PRISMA_STATUS_EXIT : process.env.FAKE_PRISMA_DIFF_EXIT;",
          "process.exit(Number(raw || 0));",
          "",
        ].join("\n"),
      );
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
        // JEST_WORKER_ID is already inherited via scrubbedEnv (this test runs under jest).
        SCHEMA_DRIFT_PRISMA_CLI: fakePrisma,
        FAKE_PRISMA_STATUS_EXIT: "0",
        FAKE_PRISMA_DIFF_EXIT: "2",
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

      // The drift step runs after deploy, using the stub (proving the override actually
      // reached the drift child), and its non-zero status is propagated as prod-migrate's own.
      expect(res.stdout).toContain("post-deploy schema drift check");
      expect(res.stderr).toContain("SCHEMA_DRIFT_PRISMA_CLI override in effect");
      expect(res.stderr).toContain("DRIFT DETECTED");
      expect(res.stderr).toContain("post-deploy drift check FAILED");
      expect(res.stdout).not.toContain("✅ Migration applied.");
      // A spawnSync timeout-kill (Node's own {timeout} option firing) also leaves res.status
      // null, indistinguishable from a real wrong value by the bare toBe(2) below. Assert
      // res.signal first so a timeout-kill fails here with a clear, distinguishable message
      // instead of the misleading "Expected 2, Received null".
      expect(res.signal).toBeNull();
      expect(res.status).toBe(2);
    });

    it("uses the real prisma CLI for the drift check when SCHEMA_DRIFT_PRISMA_CLI is unset", () => {
      // The real path is proven the same way schema-drift-script.spec.ts's T3(h) does: spawn
      // the exact script prod-migrate.mjs's drift step invokes, with --dry-run so it never
      // touches a database or connects anywhere, and assert the printed argv names the real
      // resolved prisma CLI module rather than any stand-in.
      const driftScript = path.resolve(API_DIR, "scripts/schema-drift.mjs");
      const realPrisma = require.resolve("prisma/build/index.js", { paths: [API_DIR] });
      const env = scrubbedEnv({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db" });
      delete env.SCHEMA_DRIFT_PRISMA_CLI;

      const res = spawnSync(process.execPath, [driftScript, "--dry-run"], {
        cwd: API_DIR,
        encoding: "utf8",
        env,
      });

      expect(res.stdout).toContain(realPrisma);
      expect(res.stdout).not.toContain(fakePrisma);
      expect(res.status).toBe(0);
    });
  });
});
