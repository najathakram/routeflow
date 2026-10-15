import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Row 531: the owner-run, READ-ONLY census of buyer lines that could have been stored at the wrong
 * quantity (apps/api/scripts/report-buyer-split-mismatch.mjs). Its pure parts (the line amount via
 * the house money helpers, the per-tenant grouping, the test-tenant fold) are pinned by its own
 * `--self-test` (no database); the argument gates refuse before any connection; the source is
 * read-only by construction; and report-buyer-split-mismatch.db.spec.ts runs the SQL for real.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-buyer-split-mismatch.mjs");

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

describe("report-buyer-split-mismatch.mjs (row 531)", () => {
  it("--self-test passes with no database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/self-test ok/);
  });

  it.each([
    [["--apply"], /unknown argument --apply/],
    [["stray"], /unexpected argument stray/],
    [["--since", "yesterday"], /--since needs a date/],
    [["--window", "0"], /--window needs a whole number/],
    [["--tenant"], /--tenant needs a value/],
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

  describe("source", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

    it("reads only: a read-only pool, a READ ONLY transaction that is rolled back, no write verb", () => {
      expect(src).toContain("default_transaction_read_only=on");
      expect(src).toContain("BEGIN TRANSACTION READ ONLY");
      expect(src).toContain('"ROLLBACK"');
      expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b\s/);
      expect(code).not.toMatch(/\$executeRaw|\.create\(|\.update\(|\.delete\(|COMMIT/);
    });

    it("does the money through @routeflow/pricing, not SQL or inline arithmetic", () => {
      expect(src).toContain('require("@routeflow/pricing")');
      expect(code).toMatch(/computeLineSubtotal\(/);
      expect(code).toMatch(/roundMoney\(/);
      expect(code).not.toMatch(/SUM\(/);
      expect(code).not.toMatch(/\bqty\s*\*\s*\w*[pP]rice/);
    });

    it("resolves its database through the shared report resolver", () => {
      expect(src).toContain("resolveReportDbUrl(NAME)");
    });

    it("prints tenant ids only: never a slug, order id, line id or product id", () => {
      for (const m of code.matchAll(/console\.log\(([^;]*)\);/g)) {
        expect(m[1]).not.toMatch(/\.slug|orderId|productId|\.id\b|row\.id/);
      }
    });
  });
});
