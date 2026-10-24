import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * B949 sizing script: READ-ONLY, COUNT-ONLY (apps/api/scripts/report-b949-source-deleted-applications.mjs): the live
 * credit-note applications of SOURCE_DELETED notes, by invoice status. Run under jest.scripts.config.js.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-b949-source-deleted-applications.mjs");
const src = fs.readFileSync(SCRIPT, "utf8");

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

describe("B949 sizing script", () => {
  it("--self-test exits 0", () => {
    const r = run(["--self-test"]);
    expect({ ok: r.status === 0, detail: r.status === 0 ? "" : fail(r) }).toEqual({
      ok: true,
      detail: "",
    });
  });

  it("--print-sql prints ONE read-only SELECT over the marker, the live CREDIT_NOTE payments and the invoice status, and connects to nothing", () => {
    const r = run(["--print-sql"]);
    expect(r.status).toBe(0);
    const sql = String(r.stdout).trim();
    expect(sql.startsWith("SELECT")).toBe(true);
    expect(sql).toContain(`'SOURCE_DELETED'`);
    expect(sql).toContain(`p."method" = 'CREDIT_NOTE'`);
    expect(sql).toContain(`p."status" <> 'VOID'`);
    expect(sql).toContain(`GROUP BY i."status"`);
    expect(sql.replace(/;\s*$/, "")).not.toContain(";");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    // counts and statuses only: no id / amount / tenant / customer column is selected
    const select = sql.slice(0, sql.indexOf("FROM"));
    expect(select).not.toMatch(/"id"|amount|tenant|customer|email|name/i);
  });

  it("fails closed (non-zero) when no database is configured, before any connection", () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
  });

  it("opens a READ ONLY session, rolls back, and reaches the database through the shared B768 resolver", () => {
    expect(src).toContain("BEGIN READ ONLY");
    expect(src).toContain("default_transaction_read_only = on");
    expect(src).toContain("ROLLBACK");
    expect(src).toContain("./lib/report-db-url.mjs");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\bDATABASE_URL\b/);
  });
});
