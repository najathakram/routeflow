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

function run(body: string): any {
  const code = `
import { CENSUS_SQL, CENSUS_SQL_SHA256, splitCensusSql, checkArgs, runCensus } from "${HREF}";
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

  it("takes one argument, --timeout-s=<1-1800>; anything else (a write flag too) is refused", () => {
    const out = run(`
      console.log(JSON.stringify([
        checkArgs([]), checkArgs(["--timeout-s=60"]), checkArgs(["--timeout-s=0"]), checkArgs(["--timeout-s=1801"]),
        checkArgs(["--apply"]), checkArgs(["--write"]), checkArgs(["--tenant=acme"]),
      ].map((r) => r.ok ? r.timeoutS : "refused")));
    `);
    expect(out).toEqual([300, 60, "refused", "refused", "refused", "refused", "refused"]);
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
