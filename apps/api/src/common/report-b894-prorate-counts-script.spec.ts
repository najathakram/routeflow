import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * B894 (SA-576): the owner-run, READ-ONLY census of free-unit over-credits
 * (apps/api/scripts/report-b894-prorate-counts.mjs). Its pure parts (the chunk re-derivation under both slice
 * rules, the size split, the anonymised summary) are pinned by its own `--self-test` (no database); the argument
 * gates refuse before any connection; and the source is read-only by construction.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-b894-prorate-counts.mjs");

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

describe("report-b894-prorate-counts.mjs (B894)", () => {
  it("--self-test passes with no database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/self-test ok/);
  });

  it.each([
    [["--apply"], /unknown argument --apply/],
    [["stray"], /unexpected argument stray/],
  ])("%j is refused (exit 2) before any connection", (args, message) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(message);
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/);
  });

  it("with no database configured it exits non-zero without connecting", () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/);
  });

  it("the script reads only, inside a READ ONLY transaction, and prints no identifier columns", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("SET TRANSACTION READ ONLY");
    expect(src).toContain("SET default_transaction_read_only = on");
    expect(src).toContain('await client.query("ROLLBACK")');
    expect(src).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\b\s+("|[A-Z])/);
    // stdout carries totals only: no console.log of a slug, tenant id or row id
    const logs = src.match(/console\.log\([^;]*\);/gs) ?? [];
    for (const l of logs) expect(l).not.toMatch(/\.slug|tenantId|\.id\b/);
  });
});
