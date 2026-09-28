import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * #2556: the owner-run, READ-ONLY count of what the first overdue sweep would flip
 * (apps/api/scripts/report-2520-first-overdue-sweep.mjs). Its cutoff and summary are checked by
 * its own `--self-test` (no database); the argument gates refuse before any connection.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-2520-first-overdue-sweep.mjs");

function run(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env))
    if (
      k === "DATABASE_URL" ||
      k.startsWith("RAILWAY_") ||
      k.startsWith("POSTGRES_") ||
      k.startsWith("PG")
    )
      delete env[k];
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("report-2520-first-overdue-sweep.mjs (#2556)", () => {
  it("--self-test passes with no database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/self-test ok/);
  });

  it.each([
    [["--apply"], /unexpected argument --apply/],
    [["--tenant"], /--tenant needs a tenant id/],
    [["stray"], /unexpected argument stray/],
  ])("%j is refused (exit 2) before any connection", (args, message) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(message);
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/);
  });

  it("issues SELECTs only, inside a read-only session", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("SET default_transaction_read_only = on");
    expect(src).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\s+("|[A-Z])/);
  });
});
