import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SA-773 census script: READ-ONLY, COUNT-ONLY by default (apps/api/scripts/report-sa773-over-credited-pools.mjs): goods pools and
 * orders that were already credited or refunded past what was billed. Run under jest.scripts.config.js; the SQL itself is proven
 * on stored rows in report-sa773-over-credited-pools.db.spec.ts.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-sa773-over-credited-pools.mjs");
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

describe("SA-773 census script", () => {
  it("--self-test exits 0", () => {
    const r = run(["--self-test"]);
    expect({ ok: r.status === 0, detail: r.status === 0 ? "" : fail(r) }).toEqual({
      ok: true,
      detail: "",
    });
  });

  it("--print-sql prints ONE read-only statement, and connects to nothing", () => {
    for (const args of [["--print-sql"], ["--print-sql", "--list"]]) {
      const r = run(args);
      expect(r.status).toBe(0);
      const sql = String(r.stdout).trim();
      expect(/^(WITH|SELECT)\b/.test(sql)).toBe(true);
      expect(sql.replace(/;\s*$/, "")).not.toContain(";");
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT)\b/i);
    }
  });

  it("the default statement outputs buckets and counts only: no id, name, slug, amount or customer column", () => {
    const sql = String(run(["--print-sql"]).stdout);
    const final = sql.slice(sql.indexOf("\nSELECT 'pool'"));
    const outer = final.replace(/count\([^)]*\)/g, "count()");
    expect(outer).not.toMatch(
      /\bid\b|"id"|slug|name|email|customer|"orderId"|"productId"|invoiceId|round\(/i,
    );
    expect(final).toContain(`count(*)::int AS "cases"`);
  });

  it("the list statement names ids and the overage only (never a slug, name, number or customer)", () => {
    const sql = String(run(["--print-sql", "--list"]).stdout);
    const final = sql.slice(sql.indexOf("\nSELECT 'pool'"));
    expect(final).toContain(`o."tenantId"`);
    expect(final).toContain(`o."invoiceId"`); // listed by INVOICE id
    expect(final).not.toMatch(/slug|"name"|businessName|contactName|email|Number|Number"/i);
  });

  it("a credit note is gross at the line's stored tax rate, a void note and a return's own note are not standalone, a dead return counts nothing", () => {
    const sql = String(run(["--print-sql"]).stdout);
    expect(sql).toContain(`round(cni."amount" * ii."taxRate", 2)`);
    expect(sql).toContain(`c."status"::text <> 'VOID'`);
    expect(sql).toContain(`r."creditNoteId" = c."id"`);
    expect(sql).toContain(`NOT IN ('REJECTED', 'CANCELLED')`);
  });

  it("S4: an inline return's value is 0 when its OWN credit note is VOID (the statement joins the note and zeroes both money sums)", () => {
    const sql = String(run(["--print-sql"]).stdout);
    const inline = sql.slice(sql.indexOf("), inline AS ("), sql.indexOf("), pool_over AS ("));
    expect(inline).toContain(`LEFT JOIN "CreditNote" c ON c."id" = r."creditNoteId"`);
    // both sums (the pool's gross and the order's net) are guarded; the DB spec proves the rows (X6)
    expect(inline.match(/c\."status"::text = 'VOID' THEN 0/g)).toHaveLength(2);
    // the order's inline side is built on those two sums, never on the raw item columns
    expect(
      sql.slice(sql.indexOf("), order_inline AS ("), sql.indexOf("), order_external AS (")),
    ).toContain(`sum("creditedNet")`);
  });

  it("--list prints ids, so it is refused (exit 2, before any connection) unless stdout is a terminal or the run acknowledges ids-only output", () => {
    const refused = run(["--list"]); // spawnSync pipes stdout: not a terminal
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/--ack-ids-only/);
    expect(String(refused.stdout)).toBe("");
    // acknowledged, by flag or by env: it gets past the gate and then fails closed on the missing database instead
    for (const r of [
      run(["--list", "--ack-ids-only"]),
      run(["--list"], { SA773_ACK_IDS_ONLY: "1" }),
    ]) {
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toMatch(/--ack-ids-only/);
      expect(r.stderr).toMatch(/no usable database URL|DATABASE/i);
    }
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
