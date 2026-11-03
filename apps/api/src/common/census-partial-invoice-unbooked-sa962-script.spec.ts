import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

/**
 * SA-962 G5 / SA-1098 A-5 census (`apps/api/scripts/census-partial-invoice-unbooked-sa962.mjs`). Spawned, never imported into Jest (it
 * is ESM). Pins the embedded SQL (sha-256), that it splits into its two queries and writes nothing, that it selects no id, name, slug or
 * money, that the session goes read-only before any read and a session that stays writable is refused, and that no argument can
 * switch a write on. The SQL runs against fixtures in ./census-partial-invoice-unbooked-sa962.db.spec.ts.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/census-partial-invoice-unbooked-sa962.mjs");
const HREF = pathToFileURL(SCRIPT).href;
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

const CENSUS_SHA256 = "8315195de5c9ff3c2844b1263cfa58023e0f1e319c6b5da9f3f939ab929e06c3";
// SA-962 A-1: rf-specs decisions/sa/SA-962-q721-booked.sql at 8cf53de5cb, LF line endings as filed.
const SA_BOOKED_SHA256 = "0da1da479a1707b356a4b6ffc11605e28381f9d8783f87218f43056fa4eca6f9";

function run(body: string): any {
  const code = `
import { CENSUS_SQL, CENSUS_SQL_SHA256, BOOKED_SQL, BOOKED_SQL_SHA256, splitCensusSql, checkArgs, runCensus } from "${HREF}";
${body}
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    cwd: API_DIR,
  });
  if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  return JSON.parse(res.stdout);
}

describe("SA-962 G5 census script (unbooked regulated partial invoices)", () => {
  it("embeds the SQL unchanged (sha-256): a change to it is a reviewed change", () => {
    expect(run(`console.log(JSON.stringify(CENSUS_SQL_SHA256));`)).toBe(CENSUS_SHA256);
  });

  it("splits into Q1 and Q2, every one a plain WITH ... SELECT that writes nothing", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql()));`);
    expect(qs.map((q: any) => q.name)).toEqual(["q1", "q2"]);
    for (const q of qs) {
      const code = q.sql.replace(/^--.*$/gm, "");
      expect(code).toMatch(/^\s*WITH\b/);
      expect(code).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|COPY|SET)\b/i,
      );
      expect(code.trim().endsWith(";")).toBe(true);
    }
  });

  it("selects counts only: no id, name, slug, email, price or money column leaves the query", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql()));`);
    for (const q of qs) {
      const finalSelect = q.sql
        .replace(/^--.*$/gm, "")
        .split(/\)\s*SELECT\b/i)
        .pop() as string;
      // the one place a slug is read is the CASE that turns it into a class; take that out, then nothing identifying may remain
      const selected = finalSelect.split(/\bFROM\b/i)[0].replace(/CASE[\s\S]*?\bEND\b/i, "");
      expect(selected).not.toMatch(
        /\b(slug|email|name|businessName|invoiceNumber|orderNumber|subtotal|total|unitPrice|netSales|categoryTax)\b/i,
      );
      expect(selected).not.toMatch(/\b(n|u)\.(tenant_id|invoice_id)\b(?!\))/);
    }
    // the tenant is printed as an anonymous number and a class, never its slug
    const q1 = qs[0].sql.replace(/^--.*$/gm, "");
    expect(q1).toContain("tenant_no");
    expect(q1).toContain("tenant_class");
    expect(q1).not.toMatch(/SELECT[\s\S]*\bt\.slug\s*,/i);
  });

  it("goes read-only before any read, runs each query in its own READ ONLY transaction and rolls it back", () => {
    const seen = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql.trim().split("\\n")[0].slice(0, 40));
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        return { rows: [] };
      } };
      await runCensus(client, { timeoutS: 60 });
      console.log(JSON.stringify(log));
    `);
    expect(seen).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
      "SET statement_timeout = '60s'",
      "BEGIN READ ONLY",
      expect.stringMatching(/^-- Q1 /),
      "ROLLBACK",
      "BEGIN READ ONLY",
      expect.stringMatching(/^-- Q2 /),
      "ROLLBACK",
    ]);
  });

  it("refuses (exit code 2) a session that does not come up read-only, before reading anything", () => {
    const out = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql);
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "off" }] };
        return { rows: [] };
      } };
      let exitCode = null;
      try { await runCensus(client); } catch (e) { exitCode = e.exitCode; }
      console.log(JSON.stringify({ exitCode, log }));
    `);
    expect(out.exitCode).toBe(2);
    expect(out.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
    ]);
  });

  it("takes only --timeout-s=<1-1800>; anything else (a write or backfill flag too) is refused", () => {
    const out = run(`
      console.log(JSON.stringify([
        checkArgs([]), checkArgs(["--timeout-s=60"]), checkArgs(["--timeout-s=0"]), checkArgs(["--timeout-s=1801"]),
        checkArgs(["--apply"]), checkArgs(["--write"]), checkArgs(["--backfill"]), checkArgs(["--tenant=acme"]),
        checkArgs(["--timeout-s=60", "--apply"]),
      ].map((r) => r.ok ? r.timeoutS : "refused")));
    `);
    expect(out).toEqual([
      300,
      60,
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("embeds the SA's booked-check SQL unchanged (sha-256 of rf-specs SA-962-q721-booked.sql)", () => {
    expect(run(`console.log(JSON.stringify(BOOKED_SQL_SHA256));`)).toBe(SA_BOOKED_SHA256);
    // the census SQL itself did not move when the flag was added
    expect(run(`console.log(JSON.stringify(CENSUS_SQL_SHA256));`)).toBe(CENSUS_SHA256);
  });

  it("--booked-check is one query named booked, a plain WITH ... SELECT that writes nothing and selects counts and units only", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql(BOOKED_SQL)));`);
    expect(qs.map((q: any) => q.name)).toEqual(["booked"]);
    const code = qs[0].sql.replace(/^--.*$/gm, "");
    expect(code).toMatch(/^\s*WITH\b/);
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|COPY|SET)\b/i,
    );
    expect(code.trim().endsWith(";")).toBe(true);
    // the final SELECT prints a month, a status, a class, a tier and counts: no id, name, slug, price or money
    const finalSelect = code.split(/\)\s*SELECT\b/i).pop() as string;
    const selected = finalSelect.split(/\bFROM\b/i)[0];
    expect(selected).not.toMatch(
      /\b(slug|email|name|businessName|invoiceNumber|orderNumber|subtotal|total|unitPrice|netSales|categoryTax)\b/i,
    );
    expect(selected).not.toMatch(/\bk\.(id|tenant_id|invoice_id|order_item_id)\b(?!\))/);
  });

  it("--booked-check is its own flag: it takes --timeout-s, and a write or backfill flag is still refused", () => {
    const out = run(`
      console.log(JSON.stringify([
        checkArgs(["--booked-check"]), checkArgs(["--booked-check", "--timeout-s=60"]), checkArgs([]),
        checkArgs(["--booked-check", "--apply"]), checkArgs(["--booked-check=1"]), checkArgs(["--backfill"]),
      ].map((r) => r.ok ? [r.timeoutS, r.bookedCheck] : "refused")));
    `);
    expect(out).toEqual([[300, true], [60, true], [300, false], "refused", "refused", "refused"]);
  });

  it("with --booked-check: read-only before any read, the one query in its own READ ONLY transaction, rolled back, and the census does not run", () => {
    const seen = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql.trim().split("\\n")[0].slice(0, 40));
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        return { rows: [] };
      } };
      const out = await runCensus(client, { timeoutS: 60, bookedCheck: true });
      console.log(JSON.stringify({ log, keys: Object.keys(out), spec: out.spec }));
    `);
    expect(seen.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
      "SET statement_timeout = '60s'",
      "BEGIN READ ONLY",
      expect.stringMatching(/^-- SA-962 A-1 count\./),
      "ROLLBACK",
    ]);
    expect(seen.keys).toEqual(["spec", "timingMs", "booked"]);
    expect(seen.spec.sqlSha256).toBe(SA_BOOKED_SHA256);
  });

  it("with --booked-check, a session that does not come up read-only is refused before any read", () => {
    const out = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql);
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "off" }] };
        return { rows: [] };
      } };
      let exitCode = null;
      try { await runCensus(client, { bookedCheck: true }); } catch (e) { exitCode = e.exitCode; }
      console.log(JSON.stringify({ exitCode, log }));
    `);
    expect(out.exitCode).toBe(2);
    expect(out.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
    ]);
  });

  it("is import-safe and uses the shared report resolver, with no write path in the source", () => {
    expect(SOURCE).toContain('from "./lib/report-db-url.mjs"');
    expect(SOURCE).toContain("process.argv[1] === fileURLToPath(import.meta.url)");
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/String\.raw`[\s\S]*?`;/g, "");
    expect(code).not.toMatch(
      /\.query\(\s*[`"'](INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i,
    );
  });
});
