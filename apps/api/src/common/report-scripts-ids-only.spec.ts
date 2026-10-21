import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Lead rule for owner-run reports (R5): the output carries counts and internal ids / anonymous labels ONLY - never a
 * slug, a business name or an email - and the session is read-only (`default_transaction_read_only`, statement and lock
 * timeouts). Each report has a `--self-test` that needs no database. Covered here: the dunning pause blast-radius report,
 * the RF invoice calendar census, the READ_ONLY-sellers-with-buyers count (the A3 flip gate), and the sitting-4 sizing
 * + rounding census.
 */
const API_DIR = path.resolve(__dirname, "../..");
const REPORTS = [
  "report-billing-pause-blast-radius",
  "report-rf-invoice-calendar-census",
  "report-read-only-sellers-with-buyers",
  "report-sitting4-sizing", // SA-772 §4 step 5 + SA-814 §3 C1-C4 (sitting 4)
].map((n) => ({ name: n, file: path.resolve(API_DIR, "scripts", `${n}.mjs`) }));

const read = (f: string) => fs.readFileSync(f, "utf8");
/** Source with block and line comments blanked, so prose never counts. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const SET_RO = '"SET default_transaction_read_only = on"';

describe.each(REPORTS)("$name", ({ file }) => {
  const src = read(file);
  const noDbEnv = () => {
    const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: "" };
    for (const k of [
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      "RAILWAY_TCP_PROXY_DOMAIN",
      "RAILWAY_TCP_PROXY_PORT",
    ])
      delete env[k];
    return env as NodeJS.ProcessEnv;
  };

  it("--self-test passes with no database", () => {
    const res = spawnSync(process.execPath, [file, "--self-test"], {
      encoding: "utf8",
      cwd: API_DIR,
      env: noDbEnv(),
    });
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it("exits 2 without connecting when no database url is configured", () => {
    const res = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      cwd: API_DIR,
      env: noDbEnv(),
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("the session is read-only with statement and lock timeouts, set before any query runs", () => {
    const c = code(src);
    expect(c).toContain(SET_RO);
    expect(c).toMatch(/statement_timeout/);
    expect(c).toMatch(/lock_timeout/);
    // either the very first query call IS the read-only SET, or the session list the loop runs starts with it
    const first = c.search(/\.query\(/);
    const firstIsSet = c.slice(first).startsWith(`.query(${SET_RO})`);
    const listedFirst = new RegExp(`READ_ONLY_SESSION\\s*=\\s*\\[\\s*${SET_RO}`).test(c);
    expect(firstIsSet || listedFirst).toBe(true);
  });

  it("contains no write or DDL statement", () => {
    const templates = (code(src).match(/`[^`]*`/g) ?? []).join("\n");
    expect(templates).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i,
    );
  });

  it("selects no slug, business name or email column (ids and counts only)", () => {
    const templates = (code(src).match(/`[^`]*`/g) ?? []).join("\n");
    expect(templates).not.toMatch(/\bslug\b|\bemail\b|businessName|\b[a-z]\."?name"?\b/i);
  });
});
