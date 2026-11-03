import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

/**
 * SA-1097 census (`apps/api/scripts/census-stored-line-pack-sa1097.mjs`). Spawned, never imported into Jest (it is ESM). Pins that the
 * embedded SQL is still the SA's file (sha-256), that it splits into its three queries and writes nothing, that the session goes
 * read-only before any read and a session that stays writable is refused, and that no argument can switch a write on.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/census-stored-line-pack-sa1097.mjs");
const HREF = pathToFileURL(SCRIPT).href;
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

const SA_FILE_SHA256 = "9b75d69a820faf304eb60ac3b5fcf9fb8ed1761b8f9635f4883651eb52ecef08";
// SA-1097 A-5: rf-specs decisions/sa/SA-1097-denominators.sql at 6faf86cde4 (unchanged at 42d50272b2), LF line endings as filed.
const SA_DENOMINATORS_SHA256 = "3291839e87910afc1c9c4b1ca6acd2703f885fc5a881ae0868c2c94e882d2e81";
// SA-1098 A-3: rf-specs decisions/sa/SA-1098-unbilled.sql at 29603388 (unchanged at f72e1c1678), LF line endings as filed.
const SA_UNBILLED_SHA256 = "4f1b503172b2e3a3aead159fe413ea55b01b22c418aa28a011f62d545eff48c1";
// SA-1097 A-7: rf-specs decisions/sa/SA-1097-third.sql at 67dfe0b894 (Q9-Q12), LF line endings as filed.
const SA_THIRD_SHA256 = "7ea78269ad97bb03bbe7ab37e6d0d90e95a7d23b9c028776d67a7409a3975877";
// SA-1097 A-8: rf-specs decisions/sa/SA-1097-q10-line.sql at 03eb45aa48 (Q10's July line again), LF line endings as filed.
const SA_Q10_LINE_SHA256 = "19d7a0f681863448f7f5f47bb91f38df93cf2dcc36aa1ceb0baadff44c4fa1d9";
// SA-1097 A-9: rf-specs decisions/sa/SA-1097-q10-owner.sql at f65160b0dc (the owner's read of the July line), LF line endings as filed.
const SA_Q10_OWNER_SHA256 = "c0ca4c4f15b7c46b044a87f4d0f2b515069c9546fc55ce8f36187b60e1b6cb29";

function run(body: string): any {
  const code = `
import { CENSUS_SQL, CENSUS_SQL_SHA256, DENOMINATORS_SQL, DENOMINATORS_SQL_SHA256, UNBILLED_SQL, UNBILLED_SQL_SHA256, THIRD_SQL, THIRD_SQL_SHA256, Q10_LINE_SQL, Q10_LINE_SQL_SHA256, Q10_OWNER_SQL, Q10_OWNER_SQL_SHA256, OWNER_OUT_NAME, OWNER_OUT_DIR, writeOwnerRead, splitCensusSql, checkArgs, runCensus } from "${HREF}";
${body}
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    cwd: API_DIR,
  });
  if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  return JSON.parse(res.stdout);
}

describe("SA-1097 census script", () => {
  it("embeds the SA's SQL unchanged (sha-256 of rf-specs SA-1097-census.sql)", () => {
    expect(run(`console.log(JSON.stringify(CENSUS_SQL_SHA256));`)).toBe(SA_FILE_SHA256);
  });

  it("splits into the three queries at the SQL's own markers, every one a plain WITH ... SELECT", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql()));`);
    expect(qs.map((q: any) => q.name)).toEqual(["q1", "q2", "q3"]);
    for (const q of qs) {
      const code = q.sql.replace(/^--.*$/gm, "");
      expect(code).toMatch(/^\s*WITH\b/);
      expect(code).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|COPY|SET)\b/i,
      );
      expect(code.trim().endsWith(";")).toBe(true);
    }
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
      "BEGIN READ ONLY",
      expect.stringMatching(/^-- Q3 /),
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

  it("takes --timeout-s=<1-1800> and --denominators; anything else (a write flag too) is refused", () => {
    const out = run(`
      console.log(JSON.stringify([
        checkArgs([]), checkArgs(["--timeout-s=60"]), checkArgs(["--timeout-s=0"]), checkArgs(["--timeout-s=1801"]),
        checkArgs(["--apply"]), checkArgs(["--write"]), checkArgs(["--tenant=acme"]),
        checkArgs(["--denominators"]), checkArgs(["--denominators", "--timeout-s=60"]), checkArgs(["--denominators=1"]),
        checkArgs(["--denominators", "--apply"]),
      ].map((r) => r.ok ? [r.timeoutS, r.denominators] : "refused")));
    `);
    expect(out).toEqual([
      [300, false],
      [60, false],
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
      [300, true],
      [60, true],
      "refused",
      "refused",
    ]);
  });

  // SA-1097 A-5: the second count, behind --denominators.
  it("embeds the SA's denominators SQL unchanged (sha-256 of rf-specs SA-1097-denominators.sql)", () => {
    expect(run(`console.log(JSON.stringify(DENOMINATORS_SQL_SHA256));`)).toBe(
      SA_DENOMINATORS_SHA256,
    );
    expect(run(`console.log(JSON.stringify(DENOMINATORS_SQL.includes("\\r")));`)).toBe(false);
  });

  it("splits the denominators into Q4 to Q8, every one a SELECT that writes nothing", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql(DENOMINATORS_SQL)));`);
    expect(qs.map((q: any) => q.name)).toEqual(["q4", "q5", "q6", "q7", "q8"]);
    for (const q of qs) {
      const code = q.sql.replace(/^--.*$/gm, "");
      expect(code).toMatch(/^\s*(WITH|SELECT)\b/);
      expect(code).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|COPY|SET)\b/i,
      );
      expect(code.trim().endsWith(";")).toBe(true);
    }
  });

  it("with the flag: read-only before any read, Q4 to Q8 each in its own READ ONLY transaction, rolled back, and the census does not run", () => {
    const seen = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql.trim().split("\\n")[0].slice(0, 40));
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        return { rows: [] };
      } };
      const out = await runCensus(client, { timeoutS: 60, denominators: true });
      console.log(JSON.stringify({ log, spec: out.spec, keys: Object.keys(out) }));
    `);
    expect(seen.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
      "SET statement_timeout = '60s'",
      ...["Q4", "Q5", "Q6", "Q7", "Q8"].flatMap((q) => [
        "BEGIN READ ONLY",
        expect.stringMatching(new RegExp(`^-- ${q} `)),
        "ROLLBACK",
      ]),
    ]);
    expect(seen.spec.sqlSha256).toBe(SA_DENOMINATORS_SHA256);
    expect(seen.keys).toEqual(["spec", "timingMs", "q4", "q5", "q6", "q7", "q8"]);
  });

  it("with the flag, a session that does not come up read-only is refused before any read", () => {
    const out = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql);
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "off" }] };
        return { rows: [] };
      } };
      let exitCode = null;
      try { await runCensus(client, { denominators: true }); } catch (e) { exitCode = e.exitCode; }
      console.log(JSON.stringify({ exitCode, log }));
    `);
    expect(out.exitCode).toBe(2);
    expect(out.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
    ]);
  });

  // SA-1098 A-3: the third count, behind --unbilled.
  it("embeds the SA's unbilled SQL unchanged (sha-256 of rf-specs SA-1098-unbilled.sql)", () => {
    expect(run(`console.log(JSON.stringify(UNBILLED_SQL_SHA256));`)).toBe(SA_UNBILLED_SHA256);
    expect(run(`console.log(JSON.stringify(UNBILLED_SQL.includes("\\r")));`)).toBe(false);
  });

  it("--unbilled is one query named unbilled, a plain WITH ... SELECT that writes nothing", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql(UNBILLED_SQL)));`);
    expect(qs.map((q: any) => q.name)).toEqual(["unbilled"]);
    const code = qs[0].sql.replace(/^--.*$/gm, "");
    expect(code).toMatch(/^\s*WITH\b/);
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|COPY|SET)\b/i,
    );
    expect(code.trim().endsWith(";")).toBe(true);
  });

  it("--unbilled is its own flag: it refuses to run together with --denominators or a write flag", () => {
    const out = run(`
      console.log(JSON.stringify([
        checkArgs(["--unbilled"]), checkArgs(["--unbilled", "--timeout-s=60"]),
        checkArgs(["--unbilled", "--denominators"]), checkArgs(["--unbilled", "--apply"]), checkArgs(["--unbilled=1"]),
      ].map((r) => r.ok ? [r.timeoutS, r.denominators, r.unbilled] : "refused")));
    `);
    expect(out).toEqual([[300, false, true], [60, false, true], "refused", "refused", "refused"]);
  });

  it("with --unbilled: read-only before any read, the one query in its own READ ONLY transaction, rolled back", () => {
    const seen = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql.trim().split("\\n")[0].slice(0, 40));
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        return { rows: [] };
      } };
      const out = await runCensus(client, { timeoutS: 60, unbilled: true });
      console.log(JSON.stringify({ log, spec: out.spec, keys: Object.keys(out) }));
    `);
    expect(seen.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
      "SET statement_timeout = '60s'",
      "BEGIN READ ONLY",
      expect.stringMatching(/^-- SA-1098 A-3 count/),
      "ROLLBACK",
    ]);
    expect(seen.spec.sqlSha256).toBe(SA_UNBILLED_SHA256);
    expect(seen.keys).toEqual(["spec", "timingMs", "unbilled"]);
  });

  // SA-1097 A-7: the third count (Q9-Q12), behind --third.
  it("embeds the SA's third-count SQL unchanged (sha-256 of rf-specs SA-1097-third.sql, A-7's Q12 included)", () => {
    expect(run(`console.log(JSON.stringify(THIRD_SQL_SHA256));`)).toBe(SA_THIRD_SHA256);
    expect(run(`console.log(JSON.stringify(THIRD_SQL.includes("\\r")));`)).toBe(false);
    expect(run(`console.log(JSON.stringify(THIRD_SQL.includes("-- Q12 ")));`)).toBe(true);
  });

  it("splits the third count into Q9 to Q12, every one a SELECT that writes nothing", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql(THIRD_SQL)));`);
    expect(qs.map((q: any) => q.name)).toEqual(["q9", "q10", "q11", "q12"]);
    for (const q of qs) {
      const code = q.sql.replace(/^--.*$/gm, "");
      expect(code).toMatch(/^\s*(WITH|SELECT)\b/);
      expect(code).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|COPY|SET)\b/i,
      );
      expect(code.trim().endsWith(";")).toBe(true);
    }
  });

  it("--third is its own flag: it refuses to run with --denominators, --unbilled or a write flag", () => {
    const out = run(`
      console.log(JSON.stringify([
        checkArgs(["--third"]), checkArgs(["--third", "--timeout-s=60"]),
        checkArgs(["--third", "--denominators"]), checkArgs(["--third", "--unbilled"]), checkArgs(["--third", "--apply"]), checkArgs(["--third=1"]),
      ].map((r) => r.ok ? [r.timeoutS, r.denominators, r.unbilled, r.third] : "refused")));
    `);
    expect(out).toEqual([
      [300, false, false, true],
      [60, false, false, true],
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("with --third: read-only before any read, Q9 to Q12 each in its own READ ONLY transaction, rolled back", () => {
    const seen = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql.trim().split("\\n")[0].slice(0, 40));
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        return { rows: [] };
      } };
      const out = await runCensus(client, { timeoutS: 60, third: true });
      console.log(JSON.stringify({ log, spec: out.spec, keys: Object.keys(out) }));
    `);
    expect(seen.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
      "SET statement_timeout = '60s'",
      ...["Q9", "Q10", "Q11", "Q12"].flatMap((q) => [
        "BEGIN READ ONLY",
        expect.stringMatching(new RegExp(`^-- ${q} `)),
        "ROLLBACK",
      ]),
    ]);
    expect(seen.spec.sqlSha256).toBe(SA_THIRD_SHA256);
    expect(seen.keys).toEqual(["spec", "timingMs", "q9", "q10", "q11", "q12"]);
  });

  // SA-1097 A-8: the Q10 line read, behind --q10-line.
  it("embeds the SA's Q10 line SQL unchanged (sha-256 of rf-specs SA-1097-q10-line.sql)", () => {
    expect(run(`console.log(JSON.stringify(Q10_LINE_SQL_SHA256));`)).toBe(SA_Q10_LINE_SHA256);
    expect(run(`console.log(JSON.stringify(Q10_LINE_SQL.includes("\\r")));`)).toBe(false);
  });

  it("--q10-line is one query named q10_line, a plain WITH ... SELECT that writes nothing and prints at most 20 rows", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql(Q10_LINE_SQL)));`);
    expect(qs.map((q: any) => q.name)).toEqual(["q10_line"]);
    const code = qs[0].sql.replace(/^--.*$/gm, "");
    expect(code).toMatch(/^\s*WITH\b/);
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|COPY|SET)\b/i,
    );
    expect(code.trim().endsWith("LIMIT 20;")).toBe(true);
  });

  it("--q10-line is its own flag: it refuses to run with any other count or a write flag", () => {
    const out = run(`
      console.log(JSON.stringify([
        checkArgs(["--q10-line"]), checkArgs(["--q10-line", "--timeout-s=60"]),
        checkArgs(["--q10-line", "--denominators"]), checkArgs(["--q10-line", "--unbilled"]), checkArgs(["--q10-line", "--third"]),
        checkArgs(["--q10-line", "--apply"]), checkArgs(["--q10-line=1"]),
      ].map((r) => r.ok ? [r.timeoutS, r.denominators, r.unbilled, r.third, r.q10Line] : "refused")));
    `);
    expect(out).toEqual([
      [300, false, false, false, true],
      [60, false, false, false, true],
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("with --q10-line: read-only before any read, the one query in its own READ ONLY transaction, rolled back", () => {
    const seen = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql.trim().split("\\n")[0].slice(0, 40));
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        return { rows: [] };
      } };
      const out = await runCensus(client, { timeoutS: 60, q10Line: true });
      console.log(JSON.stringify({ log, spec: out.spec, keys: Object.keys(out) }));
    `);
    expect(seen.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
      "SET statement_timeout = '60s'",
      "BEGIN READ ONLY",
      expect.stringMatching(/^-- SA-1097 A-8 count/),
      "ROLLBACK",
    ]);
    expect(seen.spec.sqlSha256).toBe(SA_Q10_LINE_SHA256);
    expect(seen.spec.sqlCommit).toBe("03eb45aa48e81c514257e84f61b3376cf9a24095");
    expect(seen.keys).toEqual(["spec", "timingMs", "q10_line"]);
  });

  // SA-1097 A-9: the owner read, behind --q10-owner. It prints names and money, so its output has rules of its own.
  it("embeds the SA's owner read unchanged (sha-256 of rf-specs SA-1097-q10-owner.sql)", () => {
    expect(run(`console.log(JSON.stringify(Q10_OWNER_SQL_SHA256));`)).toBe(SA_Q10_OWNER_SHA256);
    expect(run(`console.log(JSON.stringify(Q10_OWNER_SQL.includes("\\r")));`)).toBe(false);
  });

  it("--q10-owner is one query named q10_owner, a plain WITH ... SELECT that writes nothing and ends at LIMIT 5", () => {
    const qs = run(`console.log(JSON.stringify(splitCensusSql(Q10_OWNER_SQL)));`);
    expect(qs.map((q: any) => q.name)).toEqual(["q10_owner"]);
    const code = qs[0].sql.replace(/^--.*$/gm, "");
    expect(code).toMatch(/^\s*WITH\b/);
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|COPY|SET)\b/i,
    );
    expect(code.trim().endsWith("LIMIT 5;")).toBe(true);
  });

  it("--q10-owner is its own flag: it refuses to run with any other count or a write flag", () => {
    const out = run(`
      console.log(JSON.stringify([
        checkArgs(["--q10-owner"]), checkArgs(["--q10-owner", "--timeout-s=60"]),
        checkArgs(["--q10-owner", "--denominators"]), checkArgs(["--q10-owner", "--unbilled"]), checkArgs(["--q10-owner", "--third"]),
        checkArgs(["--q10-owner", "--q10-line"]), checkArgs(["--q10-owner", "--apply"]), checkArgs(["--q10-owner=1"]),
      ].map((r) => r.ok ? [r.timeoutS, r.denominators, r.unbilled, r.third, r.q10Line, r.q10Owner] : "refused")));
    `);
    expect(out).toEqual([
      [300, false, false, false, false, true],
      [60, false, false, false, false, true],
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("with --q10-owner: read-only before any read, the one query in its own READ ONLY transaction, rolled back", () => {
    const seen = run(`
      const log = [];
      const client = { async query(sql) {
        log.push(sql.trim().split("\\n")[0].slice(0, 40));
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        return { rows: [] };
      } };
      const out = await runCensus(client, { timeoutS: 60, q10Owner: true });
      console.log(JSON.stringify({ log, spec: out.spec, keys: Object.keys(out) }));
    `);
    expect(seen.log).toEqual([
      "SET default_transaction_read_only = on",
      "SHOW transaction_read_only",
      "SET statement_timeout = '60s'",
      "BEGIN READ ONLY",
      expect.stringMatching(/^-- SA-1097 A-9 read/),
      "ROLLBACK",
    ]);
    expect(seen.spec.sqlSha256).toBe(SA_Q10_OWNER_SHA256);
    expect(seen.spec.sqlCommit).toBe("f65160b0dcd589f57842521e6bf9c71861a6619b");
    expect(seen.keys).toEqual(["spec", "timingMs", "q10_owner"]);
  });

  describe("writeOwnerRead: names and money go to the file, never to stdout", () => {
    // Made-up values only; the point is that none of them is ever printed.
    const ROW = {
      business: "Zed Test Wholesale",
      customer: "Quux Corner Shop",
      invoice_number: "INV-TEST-0001",
      line_total: "95.00",
    };
    const writeRun = (rows: unknown[], dirName: string) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owner-read-"));
      try {
        const dir = path.join(tmp, dirName);
        const out = run(`
          import fs from "node:fs";
          const printed = [];
          const code = writeOwnerRead(
            { spec: { sqlCommit: "c", sqlSha256: "s" }, q10_owner: ${JSON.stringify(rows)} },
            { dir: ${JSON.stringify(dir)}, print: (...a) => printed.push(a.join(" ")) },
          );
          const file = ${JSON.stringify(path.join(dir, "sa1097-q10-owner-2026-11-03.json"))};
          console.log(JSON.stringify({
            code, printed, dirMade: fs.existsSync(${JSON.stringify(dir)}),
            file: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null,
            mode: fs.existsSync(file) ? (fs.statSync(file).mode & 0o777).toString(8) : null,
          }));
        `);
        return { ...out, dir };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };

    it("exactly one row: written to the file, stdout says the count and the path and nothing else", () => {
      const r = writeRun([ROW], "local-assets");
      expect(r.code).toBe(0);
      expect(r.file.q10_owner).toEqual([ROW]);
      expect(r.printed).toHaveLength(1);
      expect(r.printed[0]).toMatch(/q10_owner rows 1 written to /);
      expect(r.printed[0]).toContain("sa1097-q10-owner-2026-11-03.json");
      for (const v of Object.values(ROW)) expect(r.printed.join("\n")).not.toContain(v);
      if (process.platform !== "win32") expect(r.mode).toBe("600");
    });

    it.each([
      ["no row", []],
      ["two rows", [ROW, { ...ROW, invoice_number: "INV-TEST-0002" }]],
    ])("%s: nothing is written, the count is printed, exit 3", (_label, rows) => {
      const r = writeRun(rows as unknown[], "local-assets");
      expect(r.code).toBe(3);
      expect(r.file).toBeNull();
      expect(r.dirMade).toBe(false);
      expect(r.printed).toHaveLength(1);
      expect(r.printed[0]).toContain(`rows ${rows.length}`);
      expect(r.printed[0]).toContain("nothing written");
      for (const v of Object.values(ROW)) expect(r.printed.join("\n")).not.toContain(v);
    });

    it("the file lands in the repo's gitignored local-assets, under the SA's name", () => {
      expect(run(`console.log(JSON.stringify([OWNER_OUT_NAME, OWNER_OUT_DIR]));`)).toEqual([
        "sa1097-q10-owner-2026-11-03.json",
        path.resolve(API_DIR, "../../local-assets"),
      ]);
    });

    it("main sends the owner read to writeOwnerRead before it could print any JSON", () => {
      const main = SOURCE.slice(SOURCE.indexOf("async function main("));
      const route = main.indexOf("if (args.q10Owner) return writeOwnerRead(census)");
      const dump = main.indexOf("console.log(JSON.stringify(census");
      expect(route).toBeGreaterThan(-1);
      expect(dump).toBeGreaterThan(route);
    });
  });

  it("is import-safe and uses the shared report resolver, with no write path in the source", () => {
    expect(SOURCE).toContain('from "./lib/report-db-url.mjs"');
    expect(SOURCE).toContain("process.argv[1] === fileURLToPath(import.meta.url)");
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/String\.raw`[\s\S]*?`;/, "");
    expect(code).not.toMatch(
      /\.query\(\s*[`"'](INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i,
    );
  });
});
