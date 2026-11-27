/**
 * B1461 count report (W-1449), the drift query against a REAL Postgres. The SQL is read out of the script
 * itself (so this tests what the owner runs) and executed inside one transaction that is always rolled back:
 * nothing persists. Foreign keys are switched off for the fixture only (`session_replication_role = replica`,
 * local superuser), and the business is a throwaway id that is never a real tenant.
 *
 * Fixtures, per the booker's rules (regulated-ledger.service.ts: netHeldByLine with preserveReturns):
 *   A draft, regulated line, ledger 40 vs line 48                      -> counted
 *   B draft, ledger 40 = line 40                                       -> not counted
 *   C SENT invoice with the same drift as A                            -> not counted (DRAFT only)
 *   D draft with a live inline return REVERSAL (returnId) -10          -> not counted (returns stand)
 *   E draft with a live credit-note REVERSAL (creditNoteId) -10        -> not counted (credit notes stand)
 *   F draft, line with no tracked category, its SALE reversed to 0     -> not counted (booker target is 0)
 *   G draft, line with no tracked category, SALE still held at 40      -> counted (booker would reverse it)
 *   H draft invoice updated before the cutoff, drifted                 -> not counted
 * Expected: 2 invoices (A, G).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); `requireLocalDatabaseUrl()` refuses any non-local host.
 */
import { readFileSync } from "fs";
import * as path from "path";
import { Pool } from "pg";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

const SCRIPT = path.resolve(__dirname, "../../scripts/report-b1461-stale-draft-tax.mjs");

function driftSql(): string {
  const m = readFileSync(SCRIPT, "utf8").match(/DRIFT_SQL = `([\s\S]*?)`;/);
  if (!m) throw new Error("DRIFT_SQL not found in the script");
  return m[1];
}

describeDb("B1461 stale draft count, real Postgres (rolled back)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("counts only a DRAFT whose held ledger net differs from what its lines would book", async () => {
    const T: string = assertTestTenant(
      "qa-b1461-fixture",
      "report-b1461-stale-draft-tax.db.spec.ts",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const inv = (id: string, status: string, updated: string) =>
        client.query(
          `INSERT INTO "Invoice"(id,"customerId","invoiceNumber",subtotal,total,"updatedAt","tenantId",status)
           VALUES ($1,'c',$1,0,0,$2::timestamp,$3,$4::"InvoiceStatus")`,
          [id, updated, T, status],
        );
      const item = (id: string, invoiceId: string, subtotal: number, cat: string | null) =>
        client.query(
          `INSERT INTO "InvoiceItem"(id,"invoiceId",description,qty,"unitPrice",subtotal,"updatedAt","tenantId","trackedCategoryId")
           VALUES ($1,$2,'d',4,10,$3,now(),$4,$5)`,
          [id, invoiceId, subtotal, T, cat],
        );
      const led = (
        id: string,
        invoiceId: string,
        itemId: string,
        type: "SALE" | "REVERSAL",
        net: number,
        extra: { returnId?: string; creditNoteId?: string } = {},
      ) =>
        client.query(
          `INSERT INTO "RegulatedSalesLedger"(id,"periodBucket",qty,"soldAt","tenantId","trackedCategoryId","invoiceId","invoiceItemId","entryType","netSales","categoryTax","returnId","creditNoteId")
           VALUES ($1,'2026-11',4,now(),$2,'x',$3,$4,$5::"LedgerEntryType",$6,0,$7,$8)`,
          [id, T, invoiceId, itemId, type, net, extra.returnId ?? null, extra.creditNoteId ?? null],
        );
      const recent = "2026-11-10";

      await inv("iA", "DRAFT", recent);
      await item("liA", "iA", 48, "cat");
      await led("lA", "iA", "liA", "SALE", 40);

      await inv("iB", "DRAFT", recent);
      await item("liB", "iB", 40, "cat");
      await led("lB", "iB", "liB", "SALE", 40);

      await inv("iC", "SENT", recent);
      await item("liC", "iC", 48, "cat");
      await led("lC", "iC", "liC", "SALE", 40);

      await inv("iD", "DRAFT", recent);
      await item("liD", "iD", 40, "cat");
      await led("lD1", "iD", "liD", "SALE", 40);
      await led("lD2", "iD", "liD", "REVERSAL", -10, { returnId: "r1" });

      await inv("iE", "DRAFT", recent);
      await item("liE", "iE", 40, "cat");
      await led("lE1", "iE", "liE", "SALE", 40);
      await led("lE2", "iE", "liE", "REVERSAL", -10, { creditNoteId: "cn1" });

      await inv("iF", "DRAFT", recent);
      await item("liF", "iF", 40, null);
      await led("lF1", "iF", "liF", "SALE", 40);
      await led("lF2", "iF", "liF", "REVERSAL", -40);

      await inv("iG", "DRAFT", recent);
      await item("liG", "iG", 40, null);
      await led("lG", "iG", "liG", "SALE", 40);

      await inv("iH", "DRAFT", "2026-10-01");
      await item("liH", "iH", 48, "cat");
      await led("lH", "iH", "liH", "SALE", 40);

      const { rows } = await client.query(driftSql(), ["2026-11-03"]);
      const mine = rows.filter((r) => r.tenantId === T);
      expect(mine).toHaveLength(1);
      expect(mine[0].invoices).toBe(2);
      expect(mine[0].lines).toBe(2);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
