import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SA-1054 r2 owner-run census (apps/api/scripts/report-a4-credit-reversal-census.mjs): READ ONLY, behind the two-step
 * live-target guard, and the read-only session is proved before any read. Run under jest.scripts.config.js; none of these
 * cases opens a database connection (every refusal happens before one).
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-a4-credit-reversal-census.mjs");
const src = fs.readFileSync(SCRIPT, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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

describe("report-a4-credit-reversal-census (SA-1054 r2)", () => {
  it("--self-test passes without a database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("self-test ok");
  });

  it("a non-loopback target is refused (exit 64) before connecting when --target-host is missing", () => {
    const r = run([], { CENSUS_DATABASE_URL: FAKE_URL });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("db.example.test");
    expect(r.stderr).not.toContain("secret");
  });

  it("a --target-host that is not the resolved host is refused (exit 65)", () => {
    const r = run(["--target-host=other.test"], { CENSUS_DATABASE_URL: FAKE_URL });
    expect(r.status).toBe(65);
  });

  it("a write-looking flag is refused (the report has no write mode)", () => {
    const r = run(["--apply"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no write mode");
  });

  it("proves the session read-only before the reads and ends in a rollback", () => {
    expect(code).toContain("default_transaction_read_only=on");
    expect(code).toContain("SHOW transaction_read_only");
    expect(code).toContain("throw ROLLBACK");
    expect(code).toContain("censusOldTypedCredits(tx)");
  });

  it("SA-1054 A-1: the printed result carries the denominators, from the one shared census, counts only and SELECT only", () => {
    const census = fs.readFileSync(
      path.resolve(API_DIR, "src/regulated/credit-reversal-census.ts"),
      "utf8",
    );
    const body = census.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // the runner prints whatever censusOldTypedCredits returns, so the denominators ride the same call (no second query home)
    expect(code).toContain("censusOldTypedCredits(tx)");
    expect(body).toMatch(/denominators:\s*await loadDenominators\(db, opts\)/);
    for (const key of [
      "creditNotesByStatus",
      "notesWithItems",
      "notesWithoutItems",
      "creditNoteItems",
      "itemsOnRegulatedLine",
      "reversalsNamingCreditNote",
      "regulatedSaleRows",
    ])
      expect(body).toContain(key);
    // every raw statement the census issues is a SELECT, and there is no write call
    const raws = [...body.matchAll(/\$queryRaw`([\s\S]*?)`/g)].map((m) => m[1].trim());
    expect(raws.length).toBeGreaterThanOrEqual(2);
    for (const sql of raws) expect(sql).toMatch(/^SELECT\b/);
    expect(body).not.toMatch(/\$executeRaw|\$queryRawUnsafe/);
    expect(body).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });

  it("holds no write: no INSERT/UPDATE/DELETE/DDL, no $executeRaw, no create/update/delete call", () => {
    expect(code).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i,
    );
    expect(code).not.toMatch(/\$executeRaw/);
    expect(code).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });
});
