import { spawnSync } from "child_process";
import * as path from "path";
import { paymentReinstatable } from "../billing/dunning-config";

/**
 * The owner-run SUSPENDED-tenant stamp census, driven as a real child process. The guard cases must refuse
 * WITHOUT connecting: the DATABASE_URL points at a port nothing listens on, so a connection attempt would
 * surface as a connection error and a different exit code.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "report-suspended-stamp-census.mjs");
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

describe("report-suspended-stamp-census (spawned guard)", () => {
  it("refuses to run without --target-host (exit 64), before connecting", () => {
    const res = run([], DEAD_URL);
    expect(res.status).toBe(64);
    expect(res.stdout).toBe("");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
  });

  it("refuses a --target-host that does not match DATABASE_URL's host (exit 65), before connecting", () => {
    const res = run(["--target-host=prod.example.test"], DEAD_URL);
    expect(res.status).toBe(65);
    expect(res.stdout).toBe("");
    expect(res.stderr).not.toMatch(/ECONNREFUSED/);
  });

  it.each(["--apply", "--fix", "--repair"])(
    "refuses %s (exit 2): there is no write mode",
    (flag) => {
      const res = run([flag, "--target-host=127.0.0.1"], DEAD_URL);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
    },
  );

  it("refuses unknown arguments (exit 2)", () => {
    expect(run(["--wat", "--target-host=127.0.0.1"], DEAD_URL).status).toBe(2);
  });
});

describe("report-suspended-stamp-census reinstatable parity", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lib = require("../../scripts/lib/report-suspended-stamp-census.cjs");

  it("the census's SUSPENDED predicate agrees with paymentReinstatable for every reason", () => {
    for (const reason of [
      null,
      "",
      "admin_set",
      "overdue_suspended",
      "stripe_cancelled",
      "weird",
    ]) {
      expect(lib.suspendedReinstatable(reason)).toBe(paymentReinstatable("SUSPENDED", reason));
    }
  });
});
