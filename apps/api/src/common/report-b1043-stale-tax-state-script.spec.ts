import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

/**
 * B1043 / SA-742r2 census: the owner-run, READ-ONLY report of invoices whose stored subtotal / tax
 * disagree with their own lines (the set the new 409 INVOICE_TAX_STATE_STALE would refuse). Pinned
 * here by running its --self-test, by exact-count classification fixtures (a mis-bucketed reason
 * changes a count), by the no-DB exit code, and by source (read-only first, no write statement).
 * The script is an ES module run by node, so the pure functions are exercised in a child process.
 */
const API_DIR = path.resolve(__dirname, "../..");
const REPORT = path.resolve(API_DIR, "scripts/report-b1043-stale-tax-state.mjs");
const src = fs.readFileSync(REPORT, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

/** Runs `body` inside an ES-module child with the script's exports bound, returns its JSON stdout. */
function runModule(body: string): unknown {
  const prog = `import * as m from ${JSON.stringify(pathToFileURL(REPORT).href)};\n${body}`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", prog], {
    encoding: "utf8",
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: "" },
  });
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout);
}

describe("report-b1043-stale-tax-state", () => {
  it("--self-test passes with no database", () => {
    const res = spawnSync(process.execPath, [REPORT, "--self-test"], {
      encoding: "utf8",
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it("exits 2 without connecting when no database url is configured", () => {
    const env = { ...process.env };
    for (const k of [
      "DATABASE_URL",
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      "RAILWAY_TCP_PROXY_DOMAIN",
      "RAILWAY_TCP_PROXY_PORT",
    ])
      delete env[k];
    const res = spawnSync(process.execPath, [REPORT], { encoding: "utf8", cwd: API_DIR, env });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("buckets every fixture into exactly one reason, with exact counts", () => {
    const out = runModule(`
      const L = (subtotal, taxRate, categoryTaxAmount = "0", tenantId = "t1") => ({ subtotal, taxRate, categoryTaxAmount, tenantId });
      const inv = (subtotal, taxAmount, extra = {}) => ({ subtotal, taxAmount, tenantId: "t1", isTaxExempt: false, ...extra });
      const fixtures = {
        consistent: [inv("100.00", "8.00"), [L("100.00", "0.08")]],
        consistentWithLevy: [inv("100.00", "13.00"), [L("100.00", "0.08", "5.00")]],
        exemptConsistent: [inv("100.00", "0.00", { isTaxExempt: true }), [L("100.00", "0.08", "5.00")]],
        subtotal: [inv("90.00", "8.00"), [L("100.00", "0.08")]],
        subtotalWinsOverTax: [inv("90.00", "4.00"), [L("100.00", "0.08")]],
        exempt: [inv("100.00", "4.00", { isTaxExempt: true }), [L("100.00", "0")]],
        zeroRateTax: [inv("100.00", "4.00"), [L("100.00", "0")]],
        roundingOneLine: [inv("100.00", "8.01"), [L("100.00", "0.08")]],
        roundingTwoLines: [inv("100.00", "8.02"), [L("50.00", "0.08"), L("50.00", "0.08")]],
        other: [inv("100.00", "9.00"), [L("100.00", "0.08")]],
        otherTwoCentsOneLine: [inv("100.00", "8.02"), [L("100.00", "0.08")]],
        nullTenantLine: [inv("100.00", "8.00"), [L("100.00", "0.08", "0", null)]],
        foreignTenantLine: [inv("100.00", "8.00"), [L("100.00", "0.08", "0", "t2")]],
        nullTenantInvoice: [inv("100.00", "8.00", { tenantId: null }), [L("100.00", "0.08", "0", null)]],
        nullTenantAndStale: [inv("100.00", "9.00", { tenantId: null }), [L("100.00", "0.08", "0", null)]],
      };
      const out = {};
      for (const [k, [i, ls]] of Object.entries(fixtures)) out[k] = m.classifyInvoice(i, ls);
      console.log(JSON.stringify(out));
    `) as Record<string, { stale: boolean; reason: string | null; foreignTenant: boolean }>;

    const verdict = Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, v.stale ? v.reason : "consistent"]),
    );
    expect(verdict).toEqual({
      consistent: "consistent",
      consistentWithLevy: "consistent",
      exemptConsistent: "consistent",
      subtotal: "subtotal",
      subtotalWinsOverTax: "subtotal",
      exempt: "exempt",
      zeroRateTax: "zeroRateTax",
      roundingOneLine: "rounding",
      roundingTwoLines: "rounding",
      other: "other",
      otherTwoCentsOneLine: "other",
      nullTenantLine: "consistent",
      foreignTenantLine: "consistent",
      nullTenantInvoice: "consistent",
      nullTenantAndStale: "other",
    });
    const foreign = Object.entries(out)
      .filter(([, v]) => v.foreignTenant)
      .map(([k]) => k)
      .sort();
    expect(foreign).toEqual([
      "foreignTenantLine",
      "nullTenantAndStale",
      "nullTenantInvoice",
      "nullTenantLine",
    ]);
    // Exact stale split over the whole fixture set.
    const tally: Record<string, number> = {};
    for (const v of Object.values(verdict)) tally[v as string] = (tally[v as string] ?? 0) + 1;
    expect(tally).toEqual({
      consistent: 6,
      subtotal: 2,
      exempt: 1,
      zeroRateTax: 1,
      rounding: 2,
      other: 3,
    });
  });

  it("pins the five formulas on fixed numbers", () => {
    const out = runModule(`
      const lines = [
        { subtotal: "100.00", taxRate: "0.0825", categoryTaxAmount: "5.00" },
        { subtotal: "50.00", taxRate: "0", categoryTaxAmount: "0" },
      ];
      console.log(JSON.stringify({
        full: m.sumInvoiceTotals(lines, { discount: 2, shipping: 10 }),
        exempt: m.sumInvoiceTotals(lines, { discount: 2, shipping: 10, isTaxExempt: true }),
        negativeLine: m.sumInvoiceTotals([{ subtotal: "-10.00", taxRate: "0.1" }, { subtotal: "30.00", taxRate: "0.1" }]),
      }));
    `);
    expect(out).toEqual({
      full: { subtotal: 150, regularTax: 8.25, categoryTax: 5, tax: 13.25, total: 171.25 },
      exempt: { subtotal: 150, regularTax: 0, categoryTax: 0, tax: 0, total: 158 },
      negativeLine: { subtotal: 20, regularTax: 2, categoryTax: 0, tax: 2, total: 22 },
    });
  });

  it("aggregates anonymously: labels, test block, age buckets, tenants affected", () => {
    const out = runModule(`
      const L = (subtotal, taxRate, tenantId) => ({ subtotal, taxRate, categoryTaxAmount: "0", tenantId });
      const inv = (id, tenantId, slug, createdAt, subtotal, taxAmount) => ({ id, tenantId, slug, createdAt, subtotal, taxAmount, isTaxExempt: false });
      const acc = m.newAccumulator();
      m.foldPage(acc, [
        inv("i1", "t-b", "acme-b", "2026-10-01T00:00:00Z", "100.00", "8.00"),
        inv("i2", "t-b", "acme-b", "2026-03-01T00:00:00Z", "100.00", "4.00"),
        inv("i3", "t-a", "acme-a", "2020-01-01T00:00:00Z", "90.00", "8.00"),
        inv("i4", "t-q", "qa-probe", "2026-10-05T00:00:00Z", "10.00", "5.00"),
      ], [
        { invoiceId: "i1", ...L("100.00", "0.08", "t-b") },
        { invoiceId: "i2", ...L("100.00", "0", "t-b") },
        { invoiceId: "i3", ...L("100.00", "0.08", "t-a") },
        { invoiceId: "i4", ...L("10.00", "0", "t-q") },
      ], new Date("2026-10-09T00:00:00Z"));
      console.log(JSON.stringify(m.summarize(acc)));
    `) as {
      live: Record<string, unknown> & { detail: Array<{ tenant: string }> };
      test: Record<string, unknown>;
    };
    expect(out.live).toMatchObject({
      scanned: 3,
      consistent: 1,
      stale: 2,
      byReason: { subtotal: 1, exempt: 0, zeroRateTax: 1, rounding: 0, other: 0 },
      staleAge: { lt30d: 0, lt1y: 1, older: 1 },
      tenantsAffected: 2,
      foreignTenantRows: 0,
    });
    expect(out.live.detail.map((d) => d.tenant)).toEqual(["tenant A", "tenant B"]);
    expect(out.test).toMatchObject({ scanned: 1, stale: 1, byReason: { zeroRateTax: 1 } });
    expect(JSON.stringify(out)).not.toMatch(/acme|qa-probe|t-a|t-b|t-q|"i[1-4]"/);
  });

  it("scopes to DRAFT by default and to every non-VOID status with --all-statuses", () => {
    const out = runModule(`
      console.log(JSON.stringify({ draft: m.INVOICE_PAGE_SQL(false), all: m.INVOICE_PAGE_SQL(true) }));
    `) as { draft: string; all: string };
    expect(out.draft).toContain(`i.status = 'DRAFT'`);
    expect(out.draft).toContain("LIMIT 500");
    expect(out.draft).toContain("i.id > $1::text");
    expect(out.all).toContain(`i.status <> 'VOID'`);
    expect(out.all).not.toContain("'DRAFT'");
  });

  it("is read-only: the session is set read-only first and no write statement appears", () => {
    const readOnly = src.indexOf("SET default_transaction_read_only = on");
    expect(readOnly).toBeGreaterThan(0);
    expect(src.indexOf("client.query(INVOICE_PAGE_SQL", readOnly)).toBeGreaterThan(readOnly);
    expect(src.indexOf("client.query(LINES_SQL", readOnly)).toBeGreaterThan(readOnly);
    // No statement other than the SET, SET and SELECT reaches the client.
    for (const m of code.matchAll(/client\.query\(\s*([`"'][^`"']*)/g))
      expect(m[1]).toMatch(
        /^[`"']SET (default_transaction_read_only|statement_timeout|lock_timeout)/,
      );
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT)\b/);
    expect(code).toMatch(/await client\.end\(\)/);
    expect(code).toMatch(/finally\s*\{/);
  });

  it("never prints a tenant id, slug or document id: only the anonymous summary reaches stdout", () => {
    for (const m of code.matchAll(/console\.log\(([^;]*)\);/g))
      expect(m[1]).not.toMatch(/\.slug|\.tenantId|\.invoiceId|\.id\b/);
  });
});
