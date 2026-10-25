import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SA-840 §5 owner-run report (apps/api/scripts/report-standard-refund-tax-shortfall.mjs): READ ONLY, tenant ids and
 * counts only, behind the live-target guard. Run under jest.scripts.config.js.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-standard-refund-tax-shortfall.mjs");
const src = fs.readFileSync(SCRIPT, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FAKE_URL = "postgresql://u:secret@db.example.test:5432/railway";

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.DATABASE_URL;
  for (const k of Object.keys(e)) if (k.startsWith("RAILWAY_")) delete e[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...e, ...env } as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}
const fail = (r: ReturnType<typeof run>) =>
  `status=${r.status} signal=${r.signal} error=${r.error?.message ?? "none"}\nstderr: ${r.stderr}\nstdout: ${String(r.stdout).slice(0, 400)}`;

describe("SA-840 standard-refund tax shortfall report", () => {
  it("--self-test exits 0 (pricing, bucket fold, own over-credit column, read-only wrapper, guard, args)", () => {
    const r = run(["--self-test"]);
    expect({ ok: r.status === 0, detail: r.status === 0 ? "" : fail(r) }).toEqual({
      ok: true,
      detail: "",
    });
  });

  it("issues no write verb and no raw execute: the file is plain reads", () => {
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX)\b/i,
    );
    expect(code).not.toMatch(/\$executeRaw|\$queryRaw|\.execute\(|PrismaClient|writeFile\(/);
    // the only file it writes is the CSV under local-assets/handoff
    expect(code.match(/writeFileSync\(/g)).toHaveLength(1);
    expect(src).toContain('"local-assets"');
    expect(src).toContain('"handoff"');
  });

  it("opens a READ ONLY session, proves it with SHOW transaction_read_only (exit 2), and rolls back", () => {
    expect(src).toContain("SET default_transaction_read_only = on");
    expect(src).toContain("BEGIN READ ONLY");
    expect(src).toContain("SHOW transaction_read_only");
    expect(src).toContain("exitCode = 2");
    expect(src).toContain('"ROLLBACK"');
    expect(src).toContain("./lib/report-db-url.mjs");
    expect(code).not.toMatch(/\bDATABASE_URL\b/);
  });

  it("prices through the compiled pricing package, never its own slice math", () => {
    expect(src).toMatch(/from "@routeflow\/pricing"/);
    expect(code).toContain("refundableLineShare(");
    expect(code).toContain("sumInvoiceTotals(");
    expect(code).not.toMatch(/billedSubtotal|creditedThrough\(|computeLineSubtotal/);
  });

  it("selects no customer, name, slug or document-number column, and outputs only the SA-840 columns", () => {
    const sql = [...code.matchAll(/const Q_\w+ = `([\s\S]*?)`;/g)].map((m) => m[1]).join("\n");
    expect(sql).toContain('FROM "Return"');
    expect(sql).not.toMatch(
      /customerId|businessName|slug|returnNumber|invoiceNumber|creditNoteNumber|email|"name"/,
    );
    const columns = /export const COLUMNS = \[([\s\S]*?)\];/.exec(code)?.[1] ?? "";
    expect([...columns.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([
      "tenantId",
      "month",
      "method",
      "returns",
      "creditNotes",
      "missingRegularTax",
      "missingCategoryTax",
      "netOverCreditUnsharedDiscount",
      "invoicesTaxDiffersFromPools",
      "unpriced",
    ]);
  });

  it("refuses before connecting: exit 64 without --target-host, 65 on a wrong host, never prints the password", () => {
    const missing = run([], { DATABASE_URL: FAKE_URL });
    expect({ status: missing.status, leaked: missing.stderr.includes("secret") }).toEqual({
      status: 64,
      leaked: false,
    });
    expect(missing.stderr).toContain("db.example.test");
    const wrong = run(["--target-host=other.example.test"], { DATABASE_URL: FAKE_URL });
    expect(wrong.status).toBe(65);
  });

  it("has no write flag, and --tenant takes ids only", () => {
    for (const bad of [["--apply"], ["--fix"], ["--repair"], ["--tenant", "acme"], ["--tenant"]]) {
      const r = run(bad, { DATABASE_URL: FAKE_URL });
      expect({ args: bad, status: r.status }).toEqual({ args: bad, status: 2 });
    }
  });

  it("fails closed (non-zero) when no database is configured, before any connection", () => {
    expect(run([]).status).not.toBe(0);
  });
});
