import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * B965 sizing script: READ-ONLY, COUNT-ONLY (apps/api/scripts/report-b965-mixed-unit-returns.mjs): open STANDARD
 * returns on a mixed-unit product, by return status. Run under jest.scripts.config.js.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-b965-mixed-unit-returns.mjs");
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

describe("B965 sizing script", () => {
  it("--self-test exits 0", () => {
    const r = run(["--self-test"]);
    expect({ ok: r.status === 0, detail: r.status === 0 ? "" : fail(r) }).toEqual({
      ok: true,
      detail: "",
    });
  });

  it("--print-sql prints ONE read-only SELECT over open STANDARD returns, the order lines and the product pack, and connects to nothing", () => {
    const r = run(["--print-sql"]);
    expect(r.status).toBe(0);
    const sql = String(r.stdout).trim();
    expect(sql.startsWith("SELECT")).toBe(true);
    expect(sql).toContain(`r."kind" = 'STANDARD'`);
    expect(sql).toContain(`'PENDING', 'APPROVED', 'IN_TRANSIT', 'RECEIVED'`);
    expect(sql).toContain(`oi."boxes" IS NOT NULL OR oi."pieces" IS NOT NULL`);
    expect(sql).toContain(`GROUP BY m."status"`);
    expect(sql.replace(/;\s*$/, "")).not.toContain(";");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    // counts and statuses only: the outer SELECT names no id / amount / tenant / customer / product column
    const outer = sql.slice(0, sql.indexOf("FROM")).replace(/count\([^)]*\)/g, "count()");
    expect(outer).not.toMatch(/\bid\b|"id"|amount|tenant|customer|email|name|productId/i);
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
