import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Ops item 545 owner-run report (apps/api/scripts/report-low-stock-digest.mjs): READ ONLY, behind the two-step
 * live-target guard, the read-only session proved before any read, and counts only. Run under jest.scripts.config.js;
 * none of these cases opens a database connection (every refusal happens before one).
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-low-stock-digest.mjs");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = strip(fs.readFileSync(SCRIPT, "utf8"));
const body = strip(
  fs.readFileSync(path.resolve(API_DIR, "src/inventory/low-stock-digest-report.ts"), "utf8"),
);
const FAKE_URL = "postgresql://u:secret@db.example.test:5432/railway";
const TENANT = "123e4567-e89b-42d3-a456-426614174000";

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.DATABASE_URL;
  delete e.REPORT_DATABASE_URL;
  for (const k of Object.keys(e)) if (k.startsWith("RAILWAY_")) delete e[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...e, ...env } as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

describe("report-low-stock-digest (ops 545)", () => {
  it("--self-test passes without a database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("self-test ok");
  });

  it("needs a tenant id, and only a UUID is accepted", () => {
    expect(run([]).status).toBe(2);
    expect(run([]).stderr).toContain("--tenant=<tenant id> is required");
    const slug = run(["--tenant=acme"]);
    expect(slug.status).toBe(2);
    expect(slug.stderr).toContain("UUID");
  });

  it("a non-loopback target is refused (exit 64) before connecting when --target-host is missing", () => {
    const r = run([`--tenant=${TENANT}`], { REPORT_DATABASE_URL: FAKE_URL });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("db.example.test");
    expect(r.stderr).not.toContain("secret");
    expect(r.stderr).not.toContain(TENANT);
  });

  it("a --target-host that is not the resolved host is refused (exit 65)", () => {
    const r = run([`--tenant=${TENANT}`, "--target-host=other.test"], {
      REPORT_DATABASE_URL: FAKE_URL,
    });
    expect(r.status).toBe(65);
  });

  it("a write-looking flag is refused (the report has no write mode)", () => {
    const r = run([`--tenant=${TENANT}`, "--apply"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no write mode");
  });

  it("proves the session read-only before the reads and ends in a rollback", () => {
    expect(code).toContain("default_transaction_read_only=on");
    expect(code).toContain("SHOW transaction_read_only");
    expect(code).toContain("throw ROLLBACK");
    expect(code).toContain("reportLowStockDigest(tx, args.tenantId)");
  });

  it("holds no write: no INSERT/UPDATE/DELETE/DDL, no $executeRaw, no create/update/delete call", () => {
    for (const text of [code, body]) {
      expect(text).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i,
      );
      expect(text).not.toMatch(/\$executeRaw/);
      expect(text).not.toMatch(
        /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
      );
    }
  });

  it("the only raw statement is the read-only proof; the report module issues none", () => {
    const raws = [...code.matchAll(/\$queryRawUnsafe\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(raws.length).toBeGreaterThan(0);
    for (const arg of raws) expect(arg).toBe("SHOW_READ_ONLY");
    expect(body).not.toMatch(/\$queryRaw/);
  });

  it("reads the cron's rules from the shared module, never a copy", () => {
    expect(body).toContain('from "./low-stock-digest-rules"');
    for (const rule of ["lowStockProductWhere(", "digestRecipientWhere(", "digestOptOutWhere("])
      expect(body).toContain(rule);
    const svc = fs.readFileSync(
      path.resolve(API_DIR, "src/inventory/low-stock-digest.service.ts"),
      "utf8",
    );
    for (const rule of ["lowStockProductWhere(", "digestRecipientWhere(", "digestOptOutWhere("])
      expect(svc).toContain(rule);
  });

  it("never prints the tenant id or selects a name, address or product text into the output", () => {
    expect(code).not.toMatch(/console\.(log|error)\([^)]*tenantId/);
    expect(body).not.toMatch(/select:\s*\{[^}]*\b(name|sku|businessName|username)\b/);
  });
});
