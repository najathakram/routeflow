import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REFUND_TENDERS } from "../returns/inline-return-refund";
import { refundTenderColumn, setRefundTender } from "../returns/refund-tender";

/**
 * SA-740r2 item 7: contract for the refund-tender backfill, `apps/api/scripts/backfill-refund-tender.mjs` and its pure
 * layer `apps/api/scripts/lib/refund-tender-backfill.mjs`. No database: the pure module is ESM, evaluated in a
 * `node --input-type=module` child (the repo convention, see backfill-check-dates-script.spec.ts); the read -> write round trip is
 * the DB lane's. What must never regress: only a REFUNDED EXTERNAL_REFUND with a NULL column is planned; the audit row must be
 * the return's own tenant's (or tenantless); CARD maps to CREDIT_CARD; an unknown or missing tender stays null (never CASH); the
 * writer is the same updateMany as the API's `setRefundTender`.
 */
const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-refund-tender.mjs");
const LIB_HREF = pathToFileURL(
  path.resolve(API_DIR, "scripts/lib/refund-tender-backfill.mjs"),
).href;
const CLI_HREF = pathToFileURL(CLI).href;

function evalModule(body: string, env: Record<string, string> = {}): any {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`shim exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

const row = (over: Record<string, unknown> = {}) => ({
  returnId: "r1",
  tenantId: "t1",
  slug: "qa-x",
  status: "REFUNDED",
  refundMethod: "EXTERNAL_REFUND",
  refundTender: null,
  auditTenantId: "t1",
  meta: { tender: "CASH" },
  ...over,
});

function plan(rows: unknown[]) {
  return evalModule(
    `import { planRefundTenderBackfill } from "${LIB_HREF}";
     console.log(JSON.stringify(planRefundTenderBackfill(JSON.parse(process.env.ROWS))));`,
    { ROWS: JSON.stringify(rows) },
  ) as { plan: Array<Record<string, string>>; skipped: Record<string, number> };
}

describe("planRefundTenderBackfill", () => {
  it("plans CASH, CARD (as CREDIT_CARD) and CHECK from the audit tender", () => {
    const { plan: p } = plan([
      row({ returnId: "a", meta: { tender: "CASH" } }),
      row({ returnId: "b", meta: { tender: "CARD" } }),
      row({ returnId: "c", meta: { tender: "CHECK" } }),
    ]);
    expect(p.map((x) => [x.returnId, x.column])).toEqual([
      ["a", "CASH"],
      ["b", "CREDIT_CARD"],
      ["c", "CHECK"],
    ]);
  });

  it("an unknown or missing tender stays null: never written as CASH", () => {
    const out = plan([
      row({ meta: { tender: "BITCOIN" } }),
      row({ meta: {} }),
      row({ meta: null }),
      row({ meta: { tender: "cash" } }),
    ]);
    expect(out.plan).toEqual([]);
    expect(out.skipped.unknownTender).toBe(4);
  });

  it("the audit row must be tenantless or this return's own tenant's", () => {
    expect(plan([row({ auditTenantId: null })]).plan).toHaveLength(1);
    const other = plan([row({ auditTenantId: "t-other" })]);
    expect(other.plan).toEqual([]);
    expect(other.skipped.auditTenantMismatch).toBe(1);
  });

  it("only a REFUNDED EXTERNAL_REFUND whose column is still null: reruns plan nothing", () => {
    const out = plan([
      row({ refundTender: "CASH" }),
      row({ status: "RECEIVED" }),
      row({ refundMethod: "CREDIT_NOTE" }),
    ]);
    expect(out.plan).toEqual([]);
    expect(out.skipped.notEligible).toBe(3);
  });
});

describe("the mirrors are pinned to the API", () => {
  it("the tender -> PaymentMethod map equals refundTenderColumn for every tender", () => {
    const map = evalModule(
      `import { REFUND_TENDER_COLUMN } from "${LIB_HREF}"; console.log(JSON.stringify(REFUND_TENDER_COLUMN));`,
    );
    expect(Object.keys(map).sort()).toEqual([...REFUND_TENDERS].sort());
    for (const t of REFUND_TENDERS) expect(map[t]).toBe(refundTenderColumn(t));
  });

  it("the script's writer sends the SAME updateMany as the API's setRefundTender (one writer in effect)", async () => {
    const apiCalls: unknown[] = [];
    const db = { return: { updateMany: async (a: unknown) => (apiCalls.push(a), { count: 1 }) } };
    await setRefundTender(db, { id: "r1", tenantId: "t1", tender: "CARD" });
    const scriptCalls = evalModule(
      `import { setRefundTender } from "${LIB_HREF}";
       const calls = [];
       await setRefundTender({ return: { updateMany: async (a) => (calls.push(a), { count: 1 }) } }, { id: "r1", tenantId: "t1", tender: "CARD" });
       console.log(JSON.stringify(calls));`,
    );
    expect(scriptCalls).toEqual(apiCalls);
  });

  it("the script's writer refuses an unknown tender instead of writing a guess", () => {
    const out = evalModule(
      `import { setRefundTender } from "${LIB_HREF}";
       let refused = false;
       try { await setRefundTender({ return: { updateMany: async () => ({ count: 1 }) } }, { id: "r", tenantId: "t", tender: "ACH" }); } catch { refused = true; }
       console.log(JSON.stringify({ refused }));`,
    );
    expect(out.refused).toBe(true);
  });
});

describe("the candidate read and the CLI gates", () => {
  const sql = (): string =>
    evalModule(
      `import { CANDIDATES_SQL } from "${CLI_HREF}"; console.log(JSON.stringify(CANDIDATES_SQL));`,
      {
        DATABASE_URL: "postgres://u:p@localhost:1/none",
      },
    );

  it("joins the audit row by entityId, tenant NULL-or-equal, the EARLIEST one, and is read-only", () => {
    const text = sql();
    expect(text).toMatch(/al\."entityId" = r\.id/);
    expect(text).toMatch(/al\.action = 'inline_return\.refund'/);
    expect(text).toMatch(/al\."tenantId" IS NULL OR al\."tenantId" = r\."tenantId"/);
    expect(text).toMatch(/ORDER BY al\."createdAt" ASC\s+LIMIT 1/);
    expect(text).toMatch(/r\."refundTender" IS NULL/);
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });

  it("--apply with no --tenant-id and no --live-tenant-override refuses (exit 1) before any query", () => {
    const res = spawnSync(process.execPath, [CLI, "--apply"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgres://u:p@localhost:1/none" },
      timeout: 60_000,
    });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toMatch(/--live-tenant-override/);
  });

  it("only the setRefundTender writer touches Return: no raw UPDATE in the script", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require("node:fs").readFileSync(CLI, "utf8") as string;
    expect(src).not.toMatch(/\bUPDATE\b\s+"Return"/);
    expect(src).toContain("setRefundTender(prisma");
  });
});
