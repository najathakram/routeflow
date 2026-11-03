import { spawnSync } from "child_process";
import * as fs from "fs";
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

function run(body: string): any {
  const code = `
import { CENSUS_SQL, CENSUS_SQL_SHA256, DENOMINATORS_SQL, DENOMINATORS_SQL_SHA256, UNBILLED_SQL, UNBILLED_SQL_SHA256, splitCensusSql, checkArgs, runCensus } from "${HREF}";
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

  it("is import-safe and uses the shared report resolver, with no write path in the source", () => {
    expect(SOURCE).toContain('from "./lib/report-db-url.mjs"');
    expect(SOURCE).toContain("process.argv[1] === fileURLToPath(import.meta.url)");
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/String\.raw`[\s\S]*?`;/, "");
    expect(code).not.toMatch(
      /\.query\(\s*[`"'](INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i,
    );
  });
});
