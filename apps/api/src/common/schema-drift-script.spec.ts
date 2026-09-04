import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// T3 (R3, R4) — apps/api/scripts/schema-drift.mjs contract.
//
// The script does not exist yet on this branch, so every case here drives a real
// spawnSync and fails on the process's own observable contract (exit status,
// stdout/stderr content) rather than on an import.
//
// NOTE: spawnSync launches node successfully even when the entry module is
// missing — node itself then exits 1 with MODULE_NOT_FOUND on stderr (NOT
// status: null / ENOENT). So a bare `expect(status).toBe(1)` in case (a) is
// satisfied by the script simply not existing. Case (a) therefore also asserts
// stderr carries no "Cannot find module", and cases (b)/(c) assert their
// stdout oracles BEFORE the exit status, so the discriminating content checks
// are the ones that fail at the red gate.

const SCRIPT = path.resolve(__dirname, "../../scripts/schema-drift.mjs");

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

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

describe("schema-drift.mjs contract (T3 / R3, R4)", () => {
  it("T3(a): with no DB env at all, exits 1 and names the missing vars in stderr", () => {
    const res = run([], scrubbedEnv());

    expect(res.status).toBe(1);
    // A missing schema-drift.mjs also exits 1 — this keeps MODULE_NOT_FOUND
    // from masquerading as the script's own "missing env vars" error path.
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stderr).toContain("DATABASE_URL");
    expect(res.stderr).toContain("RAILWAY_TCP_PROXY_DOMAIN");
  });

  it("T3(b): --dry-run with a plain DATABASE_URL exits 0, redacts the password, runs the expected prisma steps, and never leaks the raw secret", () => {
    const env = scrubbedEnv({
      DATABASE_URL: "postgresql://alice:secretpw@localhost:5432/routeflow",
    });
    const res = run(["--dry-run"], env);

    // Content oracles first: the exit status alone cannot distinguish a correct
    // dry run from a script that does not exist yet.
    expect(res.stdout).toContain("alice:***@localhost:5432/routeflow");
    expect(res.stdout).toContain("migrate status");
    expect(res.stdout).toContain(
      "migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code",
    );
    expect(res.stdout + res.stderr).not.toContain("secretpw");
    // A dry run spawns no prisma, so it must never assert a verdict about the database:
    // the target line plus the two `[dry-run]` argv lines are the whole output.
    expect(res.stdout).not.toContain("NO DRIFT");
    expect(res.stdout + res.stderr).not.toContain("DRIFT DETECTED");
    expect(res.stdout.split(/\r?\n/).filter((line) => line.trim() !== "")).toHaveLength(3);
    expect(res.status).toBe(0);
  });

  it("T3(c): --dry-run prefers the Railway proxy vars over a railway.internal DATABASE_URL, redacting the proxy form and never leaking the internal host or the raw/url-encoded password", () => {
    const env = scrubbedEnv({
      DATABASE_URL: "postgresql://x:y@postgres.railway.internal:5432/railway",
      POSTGRES_USER: "u",
      POSTGRES_PASSWORD: "p w",
      POSTGRES_DB: "d",
      RAILWAY_TCP_PROXY_DOMAIN: "proxy.example",
      RAILWAY_TCP_PROXY_PORT: "5",
    });
    const res = run(["--dry-run"], env);

    // The proxy-preference oracle is the one that distinguishes "reads any URL"
    // from "prefers the proxy" (test-plan anti-vacuity note) — assert it before
    // the exit status so it is actually evaluated at the red gate.
    expect(res.stdout).toContain("u:***@proxy.example:5/d");
    const combined = res.stdout + res.stderr;
    expect(combined).not.toContain("railway.internal");
    expect(combined).not.toContain("p w");
    expect(combined).not.toContain("p%20w");
    expect(res.stdout).not.toContain("NO DRIFT");
    expect(res.status).toBe(0);
  });

  it("T3(i): --local refuses a non-local DATABASE_URL host and names it in stderr", () => {
    const env = scrubbedEnv({
      DATABASE_URL: "postgresql://u:p@db.example.com:5432/x",
    });
    const res = run(["--local"], env);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("db.example.com");
  });

  it("T3(j): --local --dry-run resolves from DATABASE_URL alone, ignoring the Railway proxy vars", () => {
    const env = scrubbedEnv({
      DATABASE_URL: "postgresql://u:p@localhost:5432/x",
      POSTGRES_USER: "u",
      POSTGRES_PASSWORD: "p",
      POSTGRES_DB: "d",
      RAILWAY_TCP_PROXY_DOMAIN: "proxy.example",
      RAILWAY_TCP_PROXY_PORT: "5",
    });
    const res = run(["--local", "--dry-run"], env);

    expect(res.stdout).toContain("localhost:5432/x");
    expect(res.stdout).not.toContain("proxy.example");
    expect(res.status).toBe(0);
  });

  // The exit-code contract itself (2 = drift, 0 = no drift, 1 = could-not-complete) and the
  // scrubbing of real child output are only reachable on the spawning path, which --dry-run
  // never takes. SCHEMA_DRIFT_PRISMA_CLI substitutes a fake prisma so those branches are
  // exercised deterministically, with no database.
  describe("exit-code contract via a stub prisma CLI", () => {
    let dir: string;
    let fakePrisma: string;

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-drift-"));
      fakePrisma = path.join(dir, "fake-prisma.mjs");
      fs.writeFileSync(
        fakePrisma,
        [
          "const argv = process.argv.slice(2);",
          "if (process.env.FAKE_PRISMA_ECHO) process.stderr.write(`${process.env.FAKE_PRISMA_ECHO}\\n`);",
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

    // JEST_WORKER_ID is passed explicitly rather than relied on by inheritance: the stub is
    // honoured ONLY inside a jest worker that also sets the override, and every honoured run
    // must announce itself. NODE_ENV is deliberately NOT part of the guard — CI's
    // db-migrations job sets `NODE_ENV: test` at job level, where the gate really runs.
    const stubEnv = (extra: Record<string, string>) =>
      scrubbedEnv({
        DATABASE_URL: "postgresql://alice:secretpw@localhost:5432/routeflow",
        SCHEMA_DRIFT_PRISMA_CLI: fakePrisma,
        JEST_WORKER_ID: "1",
        ...extra,
      });

    it("T3(d): migrate diff exiting 2 is drift — exit 2 and DRIFT DETECTED", () => {
      const res = run([], stubEnv({ FAKE_PRISMA_STATUS_EXIT: "0", FAKE_PRISMA_DIFF_EXIT: "2" }));

      expect(res.stderr).toContain("SCHEMA_DRIFT_PRISMA_CLI override in effect");
      expect(res.stderr).toContain("DRIFT DETECTED");
      expect(res.status).toBe(2);
    });

    it("T3(e): a non-zero migrate status is informational — the diff still runs and decides", () => {
      const res = run([], stubEnv({ FAKE_PRISMA_STATUS_EXIT: "1", FAKE_PRISMA_DIFF_EXIT: "0" }));

      expect(res.stderr).toContain("SCHEMA_DRIFT_PRISMA_CLI override in effect");
      expect(res.stderr).toContain("migrate status exited 1");
      expect(res.stdout).toContain("NO DRIFT");
      expect(res.status).toBe(0);
    });

    it("T3(f): a diff that could not complete exits 1 and says so — it is not reported as drift", () => {
      const res = run([], stubEnv({ FAKE_PRISMA_STATUS_EXIT: "0", FAKE_PRISMA_DIFF_EXIT: "1" }));

      expect(res.stderr).toContain("SCHEMA_DRIFT_PRISMA_CLI override in effect");
      expect(res.stderr).toContain("could not complete");
      expect(res.stderr).not.toContain("DRIFT DETECTED");
      expect(res.status).toBe(1);
    });

    it("T3(g): prisma output containing the password is scrubbed before it is echoed", () => {
      const res = run(
        [],
        scrubbedEnv({
          DATABASE_URL: "postgresql://alice:secret%20pw@localhost:5432/routeflow",
          SCHEMA_DRIFT_PRISMA_CLI: fakePrisma,
          JEST_WORKER_ID: "1",
          FAKE_PRISMA_STATUS_EXIT: "0",
          FAKE_PRISMA_DIFF_EXIT: "0",
          FAKE_PRISMA_ECHO: "P1001: cannot reach postgresql://alice:secret pw@localhost:5432",
        }),
      );

      const combined = res.stdout + res.stderr;
      expect(res.stderr).toContain("SCHEMA_DRIFT_PRISMA_CLI override in effect");
      expect(combined).toContain("***");
      expect(combined).not.toContain("secret pw");
      expect(combined).not.toContain("secret%20pw");
      expect(res.status).toBe(0);
    });

    it("T3(h) anti-masquerade: outside a jest worker the stub is ignored — the argv names the real prisma CLI, never the stand-in", () => {
      // The contract is "which CLI would run", so --dry-run proves it without a connect
      // timeout: the earlier form let real prisma exhaust its retries against a dead port
      // (~55s) to observe the same fact.
      const env = scrubbedEnv({
        DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
        SCHEMA_DRIFT_PRISMA_CLI: fakePrisma,
        FAKE_PRISMA_STATUS_EXIT: "0",
        FAKE_PRISMA_DIFF_EXIT: "0",
      });
      delete env.NODE_ENV;
      delete env.JEST_WORKER_ID;

      // Resolved from the test side too: if `prisma/build/index.js` ever stops resolving,
      // this line throws and the case fails rather than silently asserting nothing.
      const realPrisma = require.resolve("prisma/build/index.js", {
        paths: [path.resolve(__dirname, "../..")],
      });

      const res = run(["--dry-run"], env);

      expect(res.stderr).toContain("SCHEMA_DRIFT_PRISMA_CLI is ignored outside test");
      expect(res.stdout).toContain(realPrisma);
      // The stand-in must appear nowhere in the argv the script would spawn.
      expect(res.stdout).not.toContain(fakePrisma);
      expect(res.stdout).not.toContain("NO DRIFT");
      expect(res.status).toBe(0);
    }, 10_000);
  });
});
