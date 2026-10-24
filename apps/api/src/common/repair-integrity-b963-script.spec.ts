import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * B963 (MED money): scripts/repair-integrity.mjs has two CREDIT_NOTE restore SQLs (the overpaid row's void-duplicate-payment path
 * and the payment-on-dead-invoice row). Restoring money to a credit note whose source invoice was DELETED (the SOURCE_DELETED
 * AuditLog marker, #2848) makes a provenance-less credit spendable, which the API refuses on every path (B949). The script must
 * refuse too: each plan() reads the marker first and returns `blocked` with no restore action. Run under jest.scripts.config.js.
 * The module is imported (it only connects when run as a script) against a FAKE db: no database is touched.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.resolve(ROOT, "scripts/repair-integrity.mjs");
const src = fs.readFileSync(SCRIPT, "utf8");

interface Out {
  blocked?: string;
  actionSql: string[];
  before: any;
  proposal?: string;
  queries: string[];
  params: unknown[][];
  lockRows: Array<{ table: string; id: string }>;
}

function plan(fx: {
  rowId: string;
  method: "CREDIT_NOTE" | "ADVANCE";
  marked: boolean;
  ctx?: Record<string, unknown>;
}): Out {
  const code = `
    import fs from "node:fs";
    const fx = JSON.parse(fs.readFileSync(0, "utf8"));
    const { ROWS } = await import(${JSON.stringify("file://" + SCRIPT)});
    const queries = [];
    const paramsSeen = [];
    const pay = (id, amount, method, creditNoteId, advancePaymentId) => ({
      id, amount, method, status: "PAID", paidAt: null, createdAt: new Date(0),
      creditNoteId, advancePaymentId, invoiceId: "inv-1", invoice_status: "VOID",
    });
    const cn = fx.method === "CREDIT_NOTE";
    const db = {
      query: async (sql, params) => {
        queries.push(sql.replace(/\\s+/g, " ").trim());
        paramsSeen.push(params);
        if (/FROM "CreditNote" cn/.test(sql)) return { rows: fx.marked ? [{ number: "CN-0001" }] : [] };
        if (/FROM "InvoicePayment" p JOIN "Invoice" i/.test(sql))
          return { rows: [pay("pay-1", 40, fx.method, cn ? "cn-1" : null, cn ? null : "adv-1")] };
        if (/FROM "Invoice" WHERE id/.test(sql))
          return { rows: [{ id: "inv-1", status: "PAID", total: 100, subtotal: 100, discount: 0, tax: 0, shipping: 0,
            dueDate: null, paidAt: null, customerId: "c", orderId: null, tenantId: "t", invoiceNumber: "INV-1" }] };
        if (/FROM "InvoicePayment" WHERE "invoiceId"/.test(sql))
          return { rows: [pay("pay-1", 100, fx.method, cn ? "cn-1" : null, cn ? null : "adv-1"), pay("pay-2", 50, "CASH", null, null)] };
        return { rows: [] };
      },
    };
    const row = ROWS.find((r) => r.rowId === fx.rowId);
    const res = await row.plan(db, { inTx: false, confirmed: false, ...(fx.ctx ?? {}) });
    process.stdout.write(JSON.stringify({
      blocked: res.blocked, proposal: res.proposal, before: res.before,
      actionSql: (res.actions ?? []).map((a) => a.sql), queries, params: paramsSeen, lockRows: res.lockRows ?? [],
    }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    input: JSON.stringify(fx),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgresql://nobody@localhost:1/none" },
    timeout: 60_000,
  });
  if (r.status !== 0)
    throw new Error(
      `plan failed: status=${r.status} signal=${r.signal} error=${r.error?.message ?? "none"}\nstderr: ${r.stderr}\nstdout: ${String(r.stdout).slice(0, 400)}`,
    );
  return JSON.parse(r.stdout);
}

const DEAD = { rowId: "deadpay-cf082424" };
const OVER = {
  rowId: "overpaid-1a8fbb3d",
  ctx: { resolution: "void-duplicate-payment", paymentId: "pay-1" },
};
const restores = (o: Out) => o.actionSql.filter((s) => /UPDATE "CreditNote"/.test(s));

describe.each([
  ["payment-on-dead-invoice", DEAD],
  ["overpaid void-duplicate-payment", OVER],
])("B963 repair-integrity: %s", (_name, row) => {
  it("1. a SOURCE_DELETED credit note is BLOCKED with the way out, and NO CreditNote restore action is proposed", () => {
    const o = plan({ ...row, method: "CREDIT_NOTE", marked: true });
    expect(o.blocked).toMatch(/^Credit note CN-0001 came from a deleted invoice/);
    expect(o.blocked).toMatch(/Void that credit note first/);
    expect(restores(o)).toEqual([]);
    expect(
      o.actionSql.filter((s) => /^UPDATE "InvoicePayment"|^DELETE FROM "InvoicePayment"/.test(s)),
    ).toEqual([]);
  });

  it("2. an ORDINARY note keeps today's restore action", () => {
    const o = plan({ ...row, method: "CREDIT_NOTE", marked: false });
    expect(o.blocked).toBeUndefined();
    expect(restores(o)).toHaveLength(1);
    expect(restores(o)[0]).toContain(`"amountUsed" = GREATEST(0, "amountUsed" - $2)`);
  });

  it("3. the marker is part of the before-state, so a marker that appears after the dry run aborts the row at the execute-time byte-compare (drift)", () => {
    const clean = plan({ ...row, method: "CREDIT_NOTE", marked: false });
    const marked = plan({ ...row, method: "CREDIT_NOTE", marked: true });
    expect(clean.before.creditNoteSourceDeleted).toBe(false);
    expect(marked.before.creditNoteSourceDeleted).toBe(true);
    expect(JSON.stringify(clean.before)).not.toBe(JSON.stringify(marked.before));
  });

  it("4. planning is READ-ONLY: every query it issues is a SELECT (the dry run stays read-only)", () => {
    const o = plan({ ...row, method: "CREDIT_NOTE", marked: true });
    expect(o.queries.length).toBeGreaterThan(0);
    for (const sql of o.queries) expect(sql).toMatch(/^SELECT\b/i);
    expect(o.queries.some((s) => /"AuditLog"/.test(s) && /SOURCE_DELETED/.test(s))).toBe(true);
  });

  it("6. the marker is read for the PAYMENT'S NOTE id (not the payment id), and the NOTE row joins lockRows so an in-flight invoice delete commits before the execute-time re-plan", () => {
    const o = plan({ ...row, method: "CREDIT_NOTE", marked: false });
    const i = o.queries.findIndex((s) => /FROM "CreditNote" cn/.test(s));
    expect(i).toBeGreaterThan(-1);
    expect(o.params[i]).toEqual(["cn-1"]);
    expect(o.lockRows).toContainEqual({ table: "CreditNote", id: "cn-1" });
  });

  it("5. an ADVANCE payment is unaffected (no marker read, the AdvancePayment restore is proposed)", () => {
    const o = plan({ ...row, method: "ADVANCE", marked: true });
    expect(o.queries.some((s) => /"AuditLog"/.test(s))).toBe(false);
    expect(o.actionSql.some((s) => /UPDATE "AdvancePayment"/.test(s))).toBe(true);
    expect(o.blocked).toBeUndefined();
  });
});

describe("B963 repair-integrity: source pin", () => {
  it('every `UPDATE "CreditNote" SET "amountUsed"` restore sits behind the marker check in its own plan() (remove the check and this is red)', () => {
    const re = /UPDATE "CreditNote" SET\s+"amountUsed"/g;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(src))) {
      n++;
      const before = src.slice(Math.max(0, m.index - 1800), m.index);
      expect(before).toMatch(/sourceDeletedNote\(db, /);
      expect(before).toMatch(/sourceDeletedBlock\(/);
    }
    expect(n).toBe(2);
  });

  it("run as a CLI through a SYMLINKED path the script still runs (--list prints the registry; it used to exit 0 silently)", () => {
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "b963-"));
    const link = path.join(dir, "scripts-link");
    // "junction" on Windows: a directory symlink there needs elevated rights (EPERM); a junction does not
    fs.symlinkSync(path.dirname(SCRIPT), link, process.platform === "win32" ? "junction" : "dir");
    try {
      const r = spawnSync(process.execPath, [path.join(link, "repair-integrity.mjs"), "--list"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Row registry/);
      expect(r.stdout).toMatch(/deadpay-/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("row 195: the script is RETIRED — any mode other than --list refuses to connect (exit 2)", () => {
    for (const args of [[], ["--execute", "--i-have-a-fresh-backup"]]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, DATABASE_URL: "postgresql://u:p@localhost:1/none" },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/RETIRED/);
    }
  });

  it("the module only connects when run as a script (importing it for a spec never opens a connection)", () => {
    expect(src).toMatch(
      /import\.meta\.url === pathToFileURL\(fs\.realpathSync\(process\.argv\[1\] \?\? ""\)\)\.href/,
    );
  });
});
