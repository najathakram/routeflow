import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

/**
 * #2179 / SA-400a — the owner-run scale report (`apps/api/scripts/report-2179-insights-scale.mjs`).
 * Spawned, never imported into Jest (it is ESM): `--self-test` runs its pure cases with no
 * database; an ESM shim drives `summarize`/`verdict` on fixtures; and the source is pinned
 * read-only (session flag first, timeouts, one READ ONLY snapshot, SELECT-only statements, the
 * shared B768 resolver) and import-safe (the pathToFileURL entry guard).
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-2179-insights-scale.mjs");
const SCRIPT_HREF = pathToFileURL(SCRIPT).href;
const SOURCE = fs.readFileSync(SCRIPT, "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function shim(input: unknown): any {
  const code = `
import { summarize, verdict } from "${SCRIPT_HREF}";
const input = JSON.parse(process.env.R2179_INPUT);
const cohorts = summarize(new Map(input.slugs), input.counts);
console.log(JSON.stringify({ cohorts, verdict: verdict(cohorts) }));
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    cwd: API_DIR,
    env: { ...process.env, R2179_INPUT: JSON.stringify(input) },
  });
  if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  return JSON.parse(res.stdout);
}

const counts = (
  hottest: { t: string | null; lines: string; invoices: string }[],
  invoices: { t: string | null; n: string }[] = [
    { t: "t1", n: "10" },
    { t: "t2", n: "400" },
  ],
) => ({
  invoices,
  lines: [
    { t: "t1", n: "30" },
    { t: "t2", n: "4000" },
  ],
  creditNotes: [{ t: "t2", n: "7" }],
  returns: [],
  hottest,
});
const slugs = [
  ["t1", "test"],
  ["t2", "acme-foods"],
];

describe("report-2179-insights-scale.mjs (#2179 / SA-400a)", () => {
  it("--self-test passes with no database", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--self-test"], {
      encoding: "utf8",
      cwd: API_DIR,
    });
    expect(res.stdout).toContain("self-test: all cases pass");
    expect(res.status).toBe(0);
  });

  it("splits cohorts by isTestTenant and reports counts only — no id or slug in the output", () => {
    const out = shim({ slugs, counts: counts([{ t: "t2", lines: "3000", invoices: "350" }]) });
    expect(out.cohorts.test).toMatchObject({ tenants: 1, invoices: 10, invoiceLines: 30 });
    expect(out.cohorts.live).toMatchObject({
      tenants: 1,
      invoices: 400,
      largestTenantInvoices: 400,
      invoiceLines: 4000,
      creditNotes: 7,
      hottestProductLines: 3000,
      hottestProductInvoices: 350,
    });
    expect(out.verdict).toEqual({
      withinBounds: true,
      withinLines: true,
      withinTenantInvoices: true,
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("t2");
    expect(text).not.toContain("acme-foods");
  });

  it("SA-400a: BOTH bounds — the live hottest product's lines AND the largest live tenant's invoices", () => {
    // Bound 1: the hottest product's lines.
    expect(
      shim({ slugs, counts: counts([{ t: "t2", lines: "10001", invoices: "1" }]) }).verdict,
    ).toEqual({ withinBounds: false, withinLines: false, withinTenantInvoices: true });
    // Bound 2: one live tenant's TOTAL invoices, whatever its hottest product looks like.
    expect(
      shim({
        slugs,
        counts: counts([{ t: "t2", lines: "5", invoices: "5" }], [{ t: "t2", n: "10001" }]),
      }).verdict,
    ).toEqual({ withinBounds: false, withinLines: true, withinTenantInvoices: false });
    // Exactly at both bounds is within them.
    expect(
      shim({
        slugs,
        counts: counts([{ t: "t2", lines: "10000", invoices: "10000" }], [{ t: "t2", n: "10000" }]),
      }).verdict.withinBounds,
    ).toBe(true);
  });

  it("bound 2 is per tenant: several live tenants over 10k together still pass; the cohort total is still reported", () => {
    const out = shim({
      slugs: [...slugs, ["t3", "bayside-market"]],
      counts: counts(
        [{ t: "t2", lines: "50", invoices: "50" }],
        [
          { t: "t2", n: "9000" },
          { t: "t3", n: "9000" },
        ],
      ),
    });
    expect(out.cohorts.live).toMatchObject({ invoices: 18000, largestTenantInvoices: 9000 });
    expect(out.verdict.withinBounds).toBe(true);
  });

  it("a test tenant's hot product never counts against the live bound; an unknown tenant counts live", () => {
    const testHot = shim({
      slugs,
      counts: counts([{ t: "t1", lines: "99999", invoices: "99999" }]),
    });
    expect(testHot.verdict.withinBounds).toBe(true);
    // A test tenant's own invoice volume never counts against bound 2 either.
    const testBig = shim({
      slugs,
      counts: counts([{ t: "t2", lines: "1", invoices: "1" }], [{ t: "t1", n: "50000" }]),
    });
    expect(testBig.cohorts.test.largestTenantInvoices).toBe(50000);
    expect(testBig.verdict.withinBounds).toBe(true);
    const unknown = shim({ slugs, counts: counts([{ t: "t9", lines: "20000", invoices: "1" }]) });
    expect(unknown.cohorts.live.hottestProductLines).toBe(20000);
    expect(unknown.verdict.withinBounds).toBe(false);
  });

  describe("source pins", () => {
    it("sets the read-only session flag FIRST, then statement and lock timeouts, then one READ ONLY snapshot", () => {
      const ro = CODE.indexOf("SET default_transaction_read_only = on");
      const st = CODE.indexOf("SET statement_timeout");
      const lk = CODE.indexOf("SET lock_timeout");
      const tx = CODE.indexOf("BEGIN TRANSACTION READ ONLY");
      expect(ro).toBeGreaterThan(-1);
      expect(ro).toBeLessThan(st);
      expect(st).toBeLessThan(lk);
      expect(lk).toBeLessThan(tx);
      expect(CODE).toContain('client.query("ROLLBACK")');
    });

    it("sends only SELECTs through the guard, and has no write statement anywhere", () => {
      expect(CODE).toMatch(/assertReadOnlySql\(sql\)/);
      const sqlLiterals = CODE.match(/`[^`]*`/g) ?? [];
      for (const lit of sqlLiterals) {
        expect(lit).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
      }
    });

    it("reaches the database through the shared B768 resolver, never DATABASE_URL", () => {
      expect(CODE).toContain("resolveReportDbUrl");
      expect(CODE).not.toMatch(/DATABASE_URL/);
    });

    it("is import-safe: runs only when invoked directly (pathToFileURL entry guard)", () => {
      expect(CODE).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    });
  });
});
