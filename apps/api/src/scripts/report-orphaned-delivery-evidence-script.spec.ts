import { spawnSync } from "child_process";
import * as path from "path";

/**
 * SA-842 §5: the owner-run orphaned-delivery-evidence report, driven as a real child process. Every case
 * here must refuse (or self-test) WITHOUT connecting: the DATABASE_URL points at a port nothing listens on,
 * so a connection attempt would surface as a connection error and a different exit code.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "report-orphaned-delivery-evidence.mjs");
const DEAD_URL = "postgresql://u:pw@127.0.0.1:1/nodb";

function run(args: string[], databaseUrl: string | null) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: databaseUrl ?? "",
  };
  for (const k of [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "RAILWAY_TCP_PROXY_DOMAIN",
    "RAILWAY_TCP_PROXY_PORT",
  ])
    delete env[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: API_DIR,
    env: env as NodeJS.ProcessEnv,
  });
}

describe("report-orphaned-delivery-evidence (spawned)", () => {
  it("--self-test passes with no database", () => {
    const res = run(["--self-test"], null);
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it("exits 2 without connecting when no database url is configured", () => {
    const res = run(["--read-only", "--target-host=127.0.0.1"], null);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("refuses without --read-only (exit 64), after printing the host and database", () => {
    const res = run(["--target-host=127.0.0.1"], DEAD_URL);
    expect(res.status).toBe(64);
    expect(res.stderr).toContain("DB host 127.0.0.1 · database nodb");
    expect(res.stderr).toContain("--read-only is required");
    expect(res.stdout).toBe("");
  });

  it("refuses without --target-host (exit 64)", () => {
    const res = run(["--read-only"], DEAD_URL);
    expect(res.status).toBe(64);
    expect(res.stderr).toContain("--target-host=<host> is required");
  });

  it("refuses when --target-host does not match the resolved host (exit 65), without connecting", () => {
    const res = run(["--read-only", "--target-host=prod.example.test"], DEAD_URL);
    expect(res.status).toBe(65);
    expect(res.stderr).toContain("does not match the resolved host 127.0.0.1");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
  });

  it("never prints the password", () => {
    const res = run(["--read-only"], DEAD_URL);
    expect(res.stderr + res.stdout).not.toContain("pw@");
  });
});
