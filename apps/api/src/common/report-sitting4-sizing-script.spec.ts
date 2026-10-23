import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * SA-772 §4 step 5 + SA-814 §3: the owner-run, READ-ONLY pre-sitting report that sizes the B296 widen (picks folder
 * variant 2a or 2b) and prints the C1-C4 rounding census (apps/api/scripts/report-sitting4-sizing.mjs). The generic
 * read-only / ids-only / no-database pins live in report-scripts-ids-only.spec.ts; this file pins what is specific.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-sitting4-sizing.mjs");
const src = readFileSync(SCRIPT, "utf8");

describe("report-sitting4-sizing.mjs (SA-772 §4 step 5, SA-814 §3)", () => {
  it("--self-test passes with no database", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--self-test"], { encoding: "utf8" });
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it("the 2a / 2b threshold is the one number SA-772 names: 500 000 rows", () => {
    expect(src).toMatch(/export const WIDEN_THRESHOLD = 500_000;/);
    expect(src).toMatch(/total < WIDEN_THRESHOLD \? "2a" : "2b"/);
  });

  it("every count runs in ONE read-only transaction that is always rolled back, through the shared resolver", () => {
    expect(src).toContain("./lib/report-db-url.mjs");
    expect(src).toContain("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    expect(src).toContain('client.query("ROLLBACK")');
    expect(src).not.toMatch(/process\.env\.DATABASE_URL/);
  });

  it("sizes both widened tables and covers the census C1-C4", () => {
    const sizing = /export const SIZING_SQL = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
    expect(sizing).toMatch(/count\(\*\) FROM "InvoiceItem"/);
    expect(sizing).toMatch(/count\(\*\) FROM "RecurringInvoiceItem"/);
    expect(src).toMatch(/sc\.key = 'settings\.taxRate'/);
    for (const name of ["C2_SQL", "C3_SQL", "C4_SQL"])
      expect(src).toMatch(new RegExp(`export const ${name} = \``));
    const c4 = /export const C4_SQL = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
    expect(c4).toMatch(/ri\."isActive" = true/);
  });
});
