import { createHash } from "crypto";
import { spawnSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

/**
 * SA-962 A-1: `--booked-check` of the census script (`apps/api/scripts/census-partial-invoice-unbooked-sa962.mjs`) run against the SA's
 * fixture (rf-specs decisions/sa/SA-962-q721-booked-fixture.sql at 8cf53de5cb, LF line endings as filed), embedded byte for byte below
 * with its sha-256 asserted. It loads into a throwaway schema of the local test database that this spec creates and drops; it never reads
 * or writes the real tables. Every name in it is made up. The child process runs the script's own runCensus (read-only session, the one
 * query), so what is pinned is the SQL as shipped.
 */
const FIXTURE_SHA256 = "35c290893489513cc23ae18c43ef2752124d2f6b592bf2283d2a3de51266261e";
const FIXTURE = String.raw`-- SA-962 A-1 fixture for SA-962-q721-booked.sql. Made-up data for a throwaway database only.
CREATE TABLE "Invoice" (id text PRIMARY KEY, "tenantId" text NOT NULL, status text NOT NULL, "orderId" text, "issueDate" timestamp, "createdAt" timestamp NOT NULL DEFAULT now());
CREATE TABLE "OrderItem" (id text PRIMARY KEY, qty numeric NOT NULL);
CREATE TABLE "InvoiceItem" (id text PRIMARY KEY, "tenantId" text NOT NULL, "invoiceId" text NOT NULL, "orderItemId" text, "trackedCategoryId" text, qty numeric NOT NULL);
CREATE TABLE "RegulatedSalesLedger" (id text PRIMARY KEY, "invoiceId" text, "invoiceItemId" text, "orderItemId" text, "trackedCategoryId" text NOT NULL, "entryType" text NOT NULL, qty numeric NOT NULL);
CREATE TABLE "RegulatedFiling" (id text PRIMARY KEY, "tenantId" text NOT NULL, "trackedCategoryId" text NOT NULL, "periodStart" timestamp NOT NULL, "periodEnd" timestamp NOT NULL, status text NOT NULL, "generatedById" text);

INSERT INTO "RegulatedFiling" VALUES ('f7', 'ta', 'c1', '2026-07-01', '2026-08-01', 'LOCKED', 'u1'),
  ('f8', 'ta', 'c1', '2026-08-01', '2026-09-01', 'GENERATED', 'u1'),
  ('f9', 'ta', 'c1', '2026-09-01', '2026-10-01', 'GENERATED', NULL),
  ('f10', 'ta', 'c1', '2026-10-01', '2026-11-01', 'FAILED', NULL);

-- A: rotated line, SALE on the old id, net equals the line: booked_old_line_id, locked
INSERT INTO "OrderItem" VALUES ('oa', 75);
INSERT INTO "Invoice" (id, "tenantId", status, "orderId", "issueDate") VALUES ('ia', 'ta', 'PAID', 'o1', '2026-07-05');
INSERT INTO "InvoiceItem" VALUES ('iia-new', 'ta', 'ia', 'oa', 'c1', 75);
INSERT INTO "RegulatedSalesLedger" VALUES ('la', 'ia', 'iia-gone', 'oa', 'c1', 'SALE', 75);
-- B: a real partial, no row anywhere: no_sale_row, under ordered, a person prepared the month
INSERT INTO "OrderItem" VALUES ('ob', 10);
INSERT INTO "Invoice" (id, "tenantId", status, "orderId", "issueDate") VALUES ('ib', 'ta', 'PAID', 'o2', '2026-08-05');
INSERT INTO "InvoiceItem" VALUES ('iib', 'ta', 'ib', 'ob', 'c1', 6);
-- C: rotated, SALE 10 and a return of 4: booked_net_differs, the daily job
INSERT INTO "OrderItem" VALUES ('oc', 10);
INSERT INTO "Invoice" (id, "tenantId", status, "orderId", "issueDate") VALUES ('ic', 'ta', 'PAID', 'o3', '2026-09-05');
INSERT INTO "InvoiceItem" VALUES ('iic-new', 'ta', 'ic', 'oc', 'c1', 10);
INSERT INTO "RegulatedSalesLedger" VALUES ('lc1', 'ic', 'iic-gone', 'oc', 'c1', 'SALE', 10), ('lc2', 'ic', 'iic-gone', 'oc', 'c1', 'REVERSAL', -4);
-- D: this invoice has no row, another invoice of the order line holds a live SALE: on_other_invoice_net_above_0, failed only
INSERT INTO "OrderItem" VALUES ('od', 8);
INSERT INTO "Invoice" (id, "tenantId", status, "orderId", "issueDate") VALUES ('id', 'ta', 'OVERDUE', 'o4', '2026-10-05'), ('id2', 'ta', 'SENT', 'o4', '2026-10-06');
INSERT INTO "InvoiceItem" VALUES ('iid', 'ta', 'id', 'od', 'c1', 8);
INSERT INTO "RegulatedSalesLedger" VALUES ('ld', 'id2', 'iid2-gone', 'od', 'c1', 'SALE', 8);
-- E: the other invoice's SALE was reversed: on_other_invoice_net_0, no filing
INSERT INTO "OrderItem" VALUES ('oe', 3);
INSERT INTO "Invoice" (id, "tenantId", status, "orderId", "issueDate") VALUES ('ie', 'ta', 'PAID', 'o5', '2026-11-02'), ('ie2', 'ta', 'VOID', 'o5', '2026-11-01');
INSERT INTO "InvoiceItem" VALUES ('iie', 'ta', 'ie', 'oe', 'c1', 3);
INSERT INTO "RegulatedSalesLedger" VALUES ('le1', 'ie2', 'iie2', 'oe', 'c1', 'SALE', 3), ('le2', 'ie2', 'iie2', 'oe', 'c1', 'REVERSAL', -3);
-- F: two live lines on one order line, one holds SALE 6: the other reads booked_net_differs (6 against 10)
INSERT INTO "OrderItem" VALUES ('of', 10);
INSERT INTO "Invoice" (id, "tenantId", status, "orderId", "issueDate") VALUES ('if', 'ta', 'PAID', 'o6', '2026-08-06');
INSERT INTO "InvoiceItem" VALUES ('iif1', 'ta', 'if', 'of', 'c1', 6), ('iif2', 'ta', 'if', 'of', 'c1', 4);
INSERT INTO "RegulatedSalesLedger" VALUES ('lf', 'if', 'iif1', 'of', 'c1', 'SALE', 6);
-- G: a freeform line on the invoice, rotated, order line null: booked_old_line_id
INSERT INTO "Invoice" (id, "tenantId", status, "orderId", "issueDate") VALUES ('ig', 'ta', 'PAID', NULL, '2026-08-07');
INSERT INTO "InvoiceItem" VALUES ('iig-new', 'ta', 'ig', NULL, 'c1', 2);
INSERT INTO "RegulatedSalesLedger" VALUES ('lg', 'ig', 'iig-gone', NULL, 'c1', 'SALE', 2);
-- Not counted: SALE on the live id, a void, a plain line, a zero line
INSERT INTO "OrderItem" VALUES ('oh', 5);
INSERT INTO "Invoice" (id, "tenantId", status, "orderId", "issueDate") VALUES ('ih', 'ta', 'PAID', 'o7', '2026-08-08'), ('ii', 'ta', 'VOID', 'o8', '2026-08-09');
INSERT INTO "InvoiceItem" VALUES ('iih', 'ta', 'ih', 'oh', 'c1', 5), ('iii', 'ta', 'ii', NULL, 'c1', 9), ('iij', 'ta', 'ih', NULL, NULL, 9), ('iik', 'ta', 'ih', NULL, 'c1', 0);
INSERT INTO "RegulatedSalesLedger" VALUES ('lh', 'ih', 'iih', 'oh', 'c1', 'SALE', 5);
`;

const SCRIPT = path.resolve(__dirname, "../../scripts/census-partial-invoice-unbooked-sa962.mjs");

interface Row {
  period: string;
  status: string;
  line_class: string;
  filing_tier: string;
  tenants: number;
  invoices: number;
  lines: number;
  units: number;
  lines_billed_under_ordered: number;
}

/** Loads the fixture into a fresh schema, runs the booked check on it in a child process, and tries one write in that same session. */
async function bookedCheck(): Promise<{ rows: Row[]; raw: string; writeRefused: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("pg");
  const url = requireLocalDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  const schema = `r721b_booked_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path = "${schema}"`);
    await client.query(FIXTURE);
    const code = `
      import { createRequire } from "node:module";
      import { runCensus } from "${pathToFileURL(SCRIPT).href}";
      const { Client } = createRequire("${pathToFileURL(SCRIPT).href}")("pg");
      const c = new Client({ connectionString: process.env.BOOKED_URL });
      await c.connect();
      await c.query('SET search_path = "' + process.env.BOOKED_SCHEMA + '"');
      const census = await runCensus(c, { bookedCheck: true });
      let writeRefused = "";
      try { await c.query("INSERT INTO \\"OrderItem\\" VALUES ('zz', 1)"); } catch (e) { writeRefused = e.message; }
      await c.end();
      console.log(JSON.stringify({ rows: census.booked, writeRefused }));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { ...process.env, BOOKED_URL: url, BOOKED_SCHEMA: schema },
    });
    if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
    const parsed = JSON.parse(res.stdout);
    const rows: Row[] = parsed.rows.map((r: Record<string, string>) => ({
      ...r,
      tenants: Number(r.tenants),
      invoices: Number(r.invoices),
      lines: Number(r.lines),
      units: Number(r.units),
      lines_billed_under_ordered: Number(r.lines_billed_under_ordered),
    }));
    return { rows, raw: res.stdout, writeRefused: parsed.writeRefused };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  }
}

describeDb("SA-962 A-1 booked check on the SA's fixture", () => {
  it("the embedded fixture is the SA's file (sha-256)", () => {
    expect(createHash("sha256").update(FIXTURE).digest("hex")).toBe(FIXTURE_SHA256);
  });

  it("each of the SA's cases lands in its class and filing tier, by month", async () => {
    const { rows } = await bookedCheck();
    const detail = rows
      .filter((r) => r.period !== "all")
      .map((r) => [
        r.period,
        r.status,
        r.line_class,
        r.filing_tier,
        r.invoices,
        r.lines,
        r.units,
        r.lines_billed_under_ordered,
      ]);
    expect(detail).toEqual(
      [
        // A: a rotated line of 75, the sale sits on the old line id
        ["2026-07", "PAID", "booked_old_line_id", "locked", 1, 1, 75, 0],
        // G: a freeform rotated line of 2
        ["2026-08", "PAID", "booked_old_line_id", "prepared_by_a_person", 1, 1, 2, 0],
        // C: a rotated line with a return of 4: on the record, net differs
        ["2026-09", "PAID", "booked_net_differs", "prepared_by_the_daily_job", 1, 1, 10, 0],
        // F: two live lines on one order line, one holds the SALE of 6: the other reads net differs
        ["2026-08", "PAID", "booked_net_differs", "prepared_by_a_person", 1, 1, 4, 0],
        // D: another invoice of the order line holds a live SALE of 8
        ["2026-10", "OVERDUE", "on_other_invoice_net_above_0", "failed_only", 1, 1, 8, 0],
        // E: the other invoice's SALE was reversed
        ["2026-11", "PAID", "on_other_invoice_net_0", "none", 1, 1, 3, 0],
        // B: a real partial of 6 of 10 with no row anywhere
        ["2026-08", "PAID", "no_sale_row", "prepared_by_a_person", 1, 1, 6, 1],
      ].sort(
        (a, b) =>
          String(a[2]).localeCompare(String(b[2])) ||
          String(a[0]).localeCompare(String(b[0])) ||
          String(a[1]).localeCompare(String(b[1])) ||
          String(a[3]).localeCompare(String(b[3])),
      ),
    );
  });

  it("the all-periods rollup per class", async () => {
    const { rows } = await bookedCheck();
    const rollup = rows
      .filter((r) => r.period === "all")
      .map((r) => [r.line_class, r.invoices, r.lines, r.units, r.lines_billed_under_ordered]);
    expect(rollup).toEqual([
      ["booked_net_differs", 2, 2, 14, 0],
      ["booked_old_line_id", 2, 2, 77, 0],
      ["no_sale_row", 1, 1, 6, 1],
      ["on_other_invoice_net_0", 1, 1, 3, 0],
      ["on_other_invoice_net_above_0", 1, 1, 8, 0],
    ]);
  });

  it("the real partial (B) is the only line counted under ordered", async () => {
    const { rows } = await bookedCheck();
    const under = rows.filter((r) => r.period !== "all" && r.lines_billed_under_ordered > 0);
    expect(under.map((r) => r.line_class)).toEqual(["no_sale_row"]);
  });

  it("prints counts only (no id, name, slug) and a write in the same session is refused", async () => {
    const { raw, writeRefused } = await bookedCheck();
    for (const s of ["ta", "ia", "iia", "iib", "o1", "oa", "c1", "u1"]) {
      expect(raw).not.toContain(`"${s}"`);
    }
    expect(writeRefused).toMatch(/read-only transaction/i);
  });
});
