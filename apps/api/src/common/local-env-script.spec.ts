import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// F10 — scripts/local-env.mjs contract.
//
// npm runs package scripts through cmd.exe on Windows, where the POSIX `VAR="x" sh -c '…'`
// prefix form fails outright ("'DATABASE_URL' is not recognized…"), so every root `local:*`
// gate was unrunnable there. The wrapper sets the environment in Node instead. These cases
// drive the real script and assert what the CHILD process observes — no database, no docker.
//
// Each case's "child command" (the part local-env.mjs hands to `shell:true`) used to be an
// inline `node -e "console.log(...)"` — a fresh `-e` invocation per case, which measured ~20s
// each locally (Windows AV behavioural scanning treats inline `-e` code execution far more
// suspiciously than a plain script file). A single trivial shim FILE, written once and invoked
// with a mode argument, sidesteps that and keeps every case well under 3s.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/local-env.mjs");

function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_") || key.startsWith("SMOKE_")) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

let shimDir: string;
let shimPath: string;

beforeAll(() => {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-env-shim-"));
  shimPath = path.join(shimDir, "shim.js");
  fs.writeFileSync(
    shimPath,
    [
      "const mode = process.argv[2];",
      "if (mode === 'db-url') process.stdout.write(String(process.env.DATABASE_URL));",
      "else if (mode === 'proxy-domain')",
      "  process.stdout.write([process.env.RAILWAY_TCP_PROXY_DOMAIN, 'end'].join('|'));",
      "else if (mode === 'smoke')",
      "  process.stdout.write(",
      "    [process.env.SMOKE_BASE_URL, process.env.SMOKE_TENANT_SLUG, process.env.SMOKE_WAIT_RETRIES].join(','),",
      "  );",
      "else if (mode === 'db-specs') process.stdout.write(String(process.env.RUN_DB_SPECS));",
      "else if (mode === 'exit') process.exit(Number(process.argv[3] || 0));",
      "else process.exit(0);",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(shimDir, { recursive: true, force: true });
});

const shim = (mode: string, arg?: string) =>
  `node "${shimPath}" ${mode}${arg !== undefined ? ` ${arg}` : ""}`;

describe("local-env.mjs contract (F10)", () => {
  it("--db exports the compose DATABASE_URL from the docker-compose defaults", () => {
    const res = run(["--db", "--", shim("db-url")], scrubbedEnv());

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stdout.trim()).toBe("postgresql://user:pass@localhost:5432/routeflow_dev");
    expect(res.status).toBe(0);
  }, 10_000);

  it("--db honours exported POSTGRES_* overrides, like docker-compose does", () => {
    const res = run(
      ["--db", "--", shim("db-url")],
      scrubbedEnv({ POSTGRES_USER: "alice", POSTGRES_DB: "other_db" }),
    );

    expect(res.stdout.trim()).toBe("postgresql://alice:pass@localhost:5432/other_db");
    expect(res.status).toBe(0);
  }, 10_000);

  it("--db strips inherited Railway proxy variables from the child environment", () => {
    // Those variables WIN over DATABASE_URL in scripts/lib/railway-db-url.mjs, so a shell that
    // has run `railway run --service postgres` would otherwise aim a local gate at production.
    const res = run(
      ["--db", "--", shim("proxy-domain")],
      scrubbedEnv({ RAILWAY_TCP_PROXY_DOMAIN: "proxy.example", RAILWAY_TCP_PROXY_PORT: "5" }),
    );

    expect(res.stdout).not.toContain("proxy.example");
    expect(res.stdout.trim()).toBe("|end");
    expect(res.status).toBe(0);
  }, 10_000);

  it("--smoke exports the three smoke variables", () => {
    const res = run(["--smoke", "--", shim("smoke")], scrubbedEnv());

    expect(res.stdout.trim()).toBe("http://localhost:3000,test,30");
    expect(res.status).toBe(0);
  }, 10_000);

  it("--db-specs exports RUN_DB_SPECS=local", () => {
    const res = run(["--db-specs", "--", shim("db-specs")], scrubbedEnv());

    expect(res.stdout.trim()).toBe("local");
    expect(res.status).toBe(0);
  }, 10_000);

  it("passes the child's exit status through", () => {
    const res = run(["--", shim("exit", "3")], scrubbedEnv());

    expect(res.status).toBe(3);
  }, 10_000);

  it("refuses a call with no command string", () => {
    const res = run(["--db"], scrubbedEnv());

    expect(res.stderr).toContain("--help");
    expect(res.status).toBe(1);
  }, 10_000);
});
