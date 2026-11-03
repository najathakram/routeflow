import { spawnSync } from "child_process";
import * as path from "path";

/**
 * SA-1088 (QD-2): the corrected-units sheet, driven as a real child process. Every case here must refuse (or
 * self-test) WITHOUT connecting: the DATABASE_URL points at a port nothing listens on, so a connection attempt
 * would surface as a connection error and a different exit code.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "report-corrected-units-sheet.mjs");
const QUERY_SELF_TEST = path.join(API_DIR, "scripts", "lib", "b681-ledger-query.self-test.mjs");
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

describe("report-corrected-units-sheet (spawned)", () => {
  it("--self-test passes with no database (QD-4 to QD-8 on fixtures)", () => {
    const res = run(["--self-test"], null);
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it("the ported query lib's self-test passes", () => {
    const res = spawnSync(process.execPath, [QUERY_SELF_TEST], { encoding: "utf8", cwd: API_DIR });
    expect(res.stdout).toMatch(/0 failed/);
    expect(res.status).toBe(0);
  });

  it.each(["--apply", "--fix", "--repair"])(
    "QD-2: refuses %s with exit 2, before any connection",
    (flag) => {
      for (const url of [DEAD_URL, null]) {
        const res = run(["--tenant", "test", flag], url);
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

  it("refuses a missing tenant, unknown arguments and a bare --tenant with exit 2", () => {
    expect(run([], DEAD_URL).status).toBe(2);
    expect(run(["--tenant"], DEAD_URL).status).toBe(2);
    expect(run(["--tenant", "test", "--wat"], DEAD_URL).status).toBe(2);
    expect(run(["--tenant", "test", "stray"], DEAD_URL).status).toBe(2);
  });

  it("refuses a live slug without --live-tenant-override (exit 2), before any connection", () => {
    const res = run(["--tenant", "acme-wholesale", "--target-host=127.0.0.1"], DEAD_URL);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--live-tenant-override");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
    expect(res.stdout).toBe("");
  });

  it("refuses an --out outside local-assets/handoff (exit 2), before any connection", () => {
    const res = run(["--tenant", "test", "--out", path.join(API_DIR, "sheet.csv")], DEAD_URL);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("local-assets/handoff");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
  });

  it("refuses without --target-host (exit 64), after printing the host and database, without connecting", () => {
    const res = run(["--tenant", "test"], DEAD_URL);
    expect(res.status).toBe(64);
    expect(res.stderr).toContain("DB host 127.0.0.1 · database nodb");
    expect(res.stderr).toContain("--target-host=<host> is required");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
    expect(res.stdout).toBe("");
  });

  it("refuses a mismatched --target-host (exit 65) without connecting", () => {
    const res = run(["--tenant", "test", "--target-host=prod.example.test"], DEAD_URL);
    expect(res.status).toBe(65);
    expect(res.stderr).toContain("does not match the resolved host 127.0.0.1");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
    expect(res.stdout).toBe("");
  });

  it("a matching --target-host passes the guard and only then tries to connect (dead port, exit 1)", () => {
    const res = run(["--tenant", "test", "--target-host=127.0.0.1"], DEAD_URL);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/ECONNREFUSED|connect/i);
    expect(res.stdout).toBe("");
  });

  it("never prints the password", () => {
    for (const args of [
      ["--tenant", "test", "--apply"],
      ["--tenant", "test", "--target-host=127.0.0.1"],
    ]) {
      const res = run(args, DEAD_URL);
      expect(res.stderr + res.stdout).not.toContain("pw@");
    }
  });
});
