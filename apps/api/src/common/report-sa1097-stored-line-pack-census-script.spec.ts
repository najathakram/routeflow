import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SA-1097 owner-run census (apps/api/scripts/report-sa1097-stored-line-pack-census.mjs): READ ONLY, behind the two-step
 * live-target guard, the read-only session proved before any read, counts only. None of these cases opens a database
 * connection (every refusal happens before one); the counts themselves are proved on real Postgres in
 * src/orders/report-sa1097-census.db.spec.ts.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-sa1097-stored-line-pack-census.mjs");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = strip(fs.readFileSync(SCRIPT, "utf8"));
const FAKE_URL = "postgresql://u:secret@db.example.test:5432/railway";

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.DATABASE_URL;
  delete e.CENSUS_DATABASE_URL;
  for (const k of Object.keys(e)) if (k.startsWith("RAILWAY_")) delete e[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...e, ...env } as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

describe("report-sa1097-stored-line-pack-census (SA-1097)", () => {
  it("--self-test passes without a database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("self-test ok");
  });

  it("a non-loopback target is refused (exit 64) before connecting when --target-host is missing, without echoing the password", () => {
    const r = run([], { CENSUS_DATABASE_URL: FAKE_URL });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("db.example.test");
    expect(r.stderr).not.toContain("secret");
  });

  it("a --target-host that is not the resolved host is refused (exit 65)", () => {
    expect(run(["--target-host=other.test"], { CENSUS_DATABASE_URL: FAKE_URL }).status).toBe(65);
  });

  it("an unknown or write-shaped flag is refused (exit 2)", () => {
    for (const flag of ["--write", "--apply", "--fix"]) expect(run([flag]).status).toBe(2);
  });

  it("is read-only by construction: no write statement, a read-only startup option, the SHOW proof, READ ONLY transactions", () => {
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/);
    expect(code).toContain("default_transaction_read_only=on");
    expect(code).toContain("BEGIN TRANSACTION READ ONLY");
    expect(code).toContain("SHOW transaction_read_only");
    expect(code).toContain("ROLLBACK");
  });

  it("selects no identity: no name, id or amount column reaches the output (counts and buckets only)", () => {
    const out = code.slice(
      code.indexOf("const result = { lines"),
      code.indexOf("async function main"),
    );
    expect(out).not.toMatch(/\b(slug|businessName|orderNumber|invoiceNumber|email|username)\b/);
  });

  it("reads the pack through the shipped rule, never a restated copy", () => {
    expect(code).toContain('require("@routeflow/pricing")');
    expect(code).toContain("resolveStoredLinePack");
  });
});
