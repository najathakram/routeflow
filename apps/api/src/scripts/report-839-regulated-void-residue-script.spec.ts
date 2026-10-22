import { spawnSync } from "child_process";
import * as path from "path";

/**
 * SA-839 section 6: the owner-run regulated void-residue report, driven as a real child process. Every case
 * here must refuse (or self-test) WITHOUT connecting: the DATABASE_URL points at a port nothing listens on,
 * so a connection attempt would surface as a connection error and a different exit code.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "report-839-regulated-void-residue.mjs");
const DEAD_URL = "postgresql://u:pw@127.0.0.1:1/nodb";

function run(args: string[], databaseUrl: string | null, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: databaseUrl ?? "",
    ...extra,
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

describe("report-839-regulated-void-residue (spawned)", () => {
  it("--self-test passes with no database", () => {
    const res = run(["--self-test"], null);
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it("exits 2 without connecting when no database url is configured", () => {
    const res = run(["--target-host=127.0.0.1"], null);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
  });

  it.each(["--apply", "--fix", "--repair"])(
    "refuses %s with exit 2, before any connection",
    (flag) => {
      for (const url of [DEAD_URL, null]) {
        const res = run([flag], url);
        expect(res.status).toBe(2);
        expect(res.stdout).toBe("");
        expect(res.stderr).toContain(`refusing ${flag}`);
        expect(res.stderr).not.toMatch(/ECONNREFUSED/);
        expect(res.stderr).not.toContain("target ");
      }
    },
  );

  it("a write flag next to --self-test is still refused", () => {
    expect(run(["--self-test", "--apply"], null).status).toBe(2);
  });

  it("refuses the retired paying-tenant flags with exit 2", () => {
    const res = run(["--allow-paying-tenant"], DEAD_URL);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("retired");
  });

  it("refuses unknown arguments and a bare --tenant with exit 2", () => {
    expect(run(["--wat"], DEAD_URL).status).toBe(2);
    expect(run(["stray"], DEAD_URL).status).toBe(2);
    expect(run(["--tenant"], DEAD_URL).status).toBe(2);
  });

  it("exits 2 on a non-local database when PROTECTED_TENANT_SLUGS is unset, without connecting", () => {
    const env = { DATABASE_URL: "postgresql://u:pw@db.example.test:5432/prod" };
    const res = spawnSync(process.execPath, [SCRIPT, "--target-host=db.example.test"], {
      encoding: "utf8",
      cwd: API_DIR,
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("PROTECTED_TENANT_SLUGS");
    expect(res.stderr).not.toMatch(/ENOTFOUND|ECONNREFUSED/);
  });

  it("refuses without --target-host (exit 64), after printing the host and database, without connecting", () => {
    const res = run([], DEAD_URL);
    expect(res.status).toBe(64);
    expect(res.stderr).toContain("DB host 127.0.0.1 · database nodb");
    expect(res.stderr).toContain("--target-host=<host> is required");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
    expect(res.stdout).toBe("");
  });

  it("refuses a mismatched --target-host (exit 65) without connecting", () => {
    const res = run(["--target-host=prod.example.test", "--json"], DEAD_URL);
    expect(res.status).toBe(65);
    expect(res.stderr).toContain("does not match the resolved host 127.0.0.1");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
    expect(res.stdout).toBe("");
  });

  it("a matching --target-host passes the guard and only then tries to connect (dead port, exit 1)", () => {
    const res = run(["--target-host=127.0.0.1"], DEAD_URL);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/ECONNREFUSED|connect/i);
    expect(res.stdout).toBe("");
  });

  it("never prints the password", () => {
    const res = run(["--apply"], DEAD_URL);
    expect(res.stderr + res.stdout).not.toContain("pw@");
    const res2 = run(["--target-host=127.0.0.1"], DEAD_URL);
    expect(res2.stderr + res2.stdout).not.toContain("pw@");
  });
});
