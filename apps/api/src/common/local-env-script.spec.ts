import { spawnSync } from "node:child_process";
import path from "node:path";

// F10 — scripts/local-env.mjs contract.
//
// npm runs package scripts through cmd.exe on Windows, where the POSIX `VAR="x" sh -c '…'`
// prefix form fails outright ("'DATABASE_URL' is not recognized…"), so every root `local:*`
// gate was unrunnable there. The wrapper sets the environment in Node instead. These cases
// drive the real script and assert what the CHILD process observes — no database, no docker.

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

const echo = (expr: string) => `node -e "console.log(${expr})"`;

describe("local-env.mjs contract (F10)", () => {
  it("--db exports the compose DATABASE_URL from the docker-compose defaults", () => {
    const res = run(["--db", "--", echo("process.env.DATABASE_URL")], scrubbedEnv());

    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stdout.trim()).toBe("postgresql://user:pass@localhost:5432/routeflow_dev");
    expect(res.status).toBe(0);
  }, 20_000);

  it("--db honours exported POSTGRES_* overrides, like docker-compose does", () => {
    const res = run(
      ["--db", "--", echo("process.env.DATABASE_URL")],
      scrubbedEnv({ POSTGRES_USER: "alice", POSTGRES_DB: "other_db" }),
    );

    expect(res.stdout.trim()).toBe("postgresql://alice:pass@localhost:5432/other_db");
    expect(res.status).toBe(0);
  }, 20_000);

  it("--db strips inherited Railway proxy variables from the child environment", () => {
    // Those variables WIN over DATABASE_URL in scripts/lib/railway-db-url.mjs, so a shell that
    // has run `railway run --service postgres` would otherwise aim a local gate at production.
    const res = run(
      ["--db", "--", echo("[process.env.RAILWAY_TCP_PROXY_DOMAIN, 'end'].join('|')")],
      scrubbedEnv({ RAILWAY_TCP_PROXY_DOMAIN: "proxy.example", RAILWAY_TCP_PROXY_PORT: "5" }),
    );

    expect(res.stdout).not.toContain("proxy.example");
    expect(res.stdout.trim()).toBe("|end");
    expect(res.status).toBe(0);
  }, 20_000);

  it("--smoke exports the three smoke variables", () => {
    const res = run(
      [
        "--smoke",
        "--",
        echo(
          "[process.env.SMOKE_BASE_URL, process.env.SMOKE_TENANT_SLUG, process.env.SMOKE_WAIT_RETRIES].join(',')",
        ),
      ],
      scrubbedEnv(),
    );

    expect(res.stdout.trim()).toBe("http://localhost:3000,test,30");
    expect(res.status).toBe(0);
  }, 20_000);

  it("--db-specs exports RUN_DB_SPECS=local", () => {
    const res = run(["--db-specs", "--", echo("process.env.RUN_DB_SPECS")], scrubbedEnv());

    expect(res.stdout.trim()).toBe("local");
    expect(res.status).toBe(0);
  }, 20_000);

  it("passes the child's exit status through", () => {
    const res = run(["--", 'node -e "process.exit(3)"'], scrubbedEnv());

    expect(res.status).toBe(3);
  }, 20_000);

  it("refuses a call with no command string", () => {
    const res = run(["--db"], scrubbedEnv());

    expect(res.stderr).toContain("--help");
    expect(res.status).toBe(1);
  }, 20_000);
});
