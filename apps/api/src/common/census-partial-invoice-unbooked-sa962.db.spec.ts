import { spawnSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

/**
 * SA-962 G5 / SA-1098 A-5: the unbooked-partial census (`apps/api/scripts/census-partial-invoice-unbooked-sa962.mjs`) run against a
 * made-up fixture in a throwaway schema of the local test database that this spec creates and drops; it never reads or writes the real
 * tables. The fixture holds only the columns the census reads. The child process runs the script's own `runCensus` (read-only session,
 * the two queries), so what is pinned is the SQL as shipped, not a copy.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/census-partial-invoice-unbooked-sa962.mjs");

const FIXTURE = `
CREATE TABLE "Tenant" (id text PRIMARY KEY, slug text NOT NULL);
CREATE TABLE "Invoice" (id text PRIMARY KEY, "tenantId" text NOT NULL, status text NOT NULL, "orderId" text,
  "issueDate" timestamp, "createdAt" timestamp NOT NULL DEFAULT now());
CREATE TABLE "InvoiceItem" (id text PRIMARY KEY, "tenantId" text NOT NULL, "invoiceId" text NOT NULL,
  "trackedCategoryId" text, qty numeric NOT NULL);
CREATE TABLE "RegulatedSalesLedger" (id text PRIMARY KEY, "invoiceItemId" text NOT NULL, "entryType" text NOT NULL);
CREATE TABLE "RegulatedFiling" (id text PRIMARY KEY, "tenantId" text NOT NULL, "trackedCategoryId" text NOT NULL,
  "periodStart" timestamp NOT NULL, "periodEnd" timestamp NOT NULL);

INSERT INTO "Tenant" VALUES ('ta', 'qa-fixture-a'), ('tb', 'acme-wholesale');
INSERT INTO "RegulatedFiling" VALUES ('f1', 'ta', 'c1', '2026-09-01', '2026-10-01');

-- ta: a September partial (order linked) with no SALE row: counted, in a filed period
INSERT INTO "Invoice" VALUES ('inv1', 'ta', 'SENT', 'o1', '2026-09-10', now());
INSERT INTO "InvoiceItem" VALUES ('ii1', 'ta', 'inv1', 'c1', 6);
-- ta: booked (a SALE row): not counted
INSERT INTO "Invoice" VALUES ('inv2', 'ta', 'SENT', 'o2', '2026-09-11', now());
INSERT INTO "InvoiceItem" VALUES ('ii2', 'ta', 'inv2', 'c1', 5);
INSERT INTO "RegulatedSalesLedger" VALUES ('l2', 'ii2', 'SALE');
-- ta: void: not counted
INSERT INTO "Invoice" VALUES ('inv3', 'ta', 'VOID', 'o3', '2026-09-12', now());
INSERT INTO "InvoiceItem" VALUES ('ii3', 'ta', 'inv3', 'c1', 3);
-- ta: an October draft partial, no row, no filing yet: counted, not filed
INSERT INTO "Invoice" VALUES ('inv4', 'ta', 'DRAFT', 'o4', '2026-10-05', now());
INSERT INTO "InvoiceItem" VALUES ('ii4', 'ta', 'inv4', 'c1', 4);
-- ta: a plain (non-regulated) line: not counted
INSERT INTO "Invoice" VALUES ('inv5', 'ta', 'SENT', 'o5', '2026-09-13', now());
INSERT INTO "InvoiceItem" VALUES ('ii5', 'ta', 'inv5', NULL, 9);
-- ta: only a REVERSAL row, no SALE row: counted (the rule is "no SALE row")
INSERT INTO "Invoice" VALUES ('inv6', 'ta', 'SENT', 'o6', '2026-09-14', now());
INSERT INTO "InvoiceItem" VALUES ('ii6', 'ta', 'inv6', 'c1', 1);
INSERT INTO "RegulatedSalesLedger" VALUES ('l6', 'ii6', 'REVERSAL');
-- ta: a zero-qty line: not counted
INSERT INTO "Invoice" VALUES ('inv8', 'ta', 'SENT', 'o8', '2026-09-15', now());
INSERT INTO "InvoiceItem" VALUES ('ii8', 'ta', 'inv8', 'c1', 0);
-- tb: a manual invoice (no order), no issue date (falls back to created), no filing: counted, class other
INSERT INTO "Invoice" VALUES ('inv7', 'tb', 'PAID', NULL, NULL, '2026-09-20');
INSERT INTO "InvoiceItem" VALUES ('ii7', 'tb', 'inv7', 'c9', 2);
`;

async function censusOn(extra = ""): Promise<{ q1: any[]; q2: any[]; raw: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("pg");
  const url = requireLocalDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  const schema = `r721_census_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path = "${schema}"`);
    await client.query(FIXTURE);
    if (extra) await client.query(extra);
    const code = `
      import { createRequire } from "node:module";
      import { runCensus } from "${pathToFileURL(SCRIPT).href}";
      const { Client } = createRequire("${pathToFileURL(SCRIPT).href}")("pg");
      const c = new Client({ connectionString: process.env.CENSUS_URL });
      await c.connect();
      await c.query('SET search_path = "' + process.env.CENSUS_SCHEMA + '"');
      const census = await runCensus(c, {});
      await c.end();
      console.log(JSON.stringify(census));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { ...process.env, CENSUS_URL: url, CENSUS_SCHEMA: schema },
    });
    if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
    const parsed = JSON.parse(res.stdout);
    return { q1: parsed.q1, q2: parsed.q2, raw: res.stdout };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  }
}

const num = (rows: any[]) =>
  rows.map((r) => ({
    ...r,
    invoices: Number(r.invoices),
    lines: Number(r.lines),
    units: Number(r.units),
    tenant_no: Number(r.tenant_no),
  }));

describeDb("SA-962 G5 census on a made-up fixture", () => {
  it("Q1: counts the non-void regulated lines with no SALE row, by anonymous tenant, class, month, order link, status and filed period", async () => {
    const { q1 } = await censusOn();
    expect(num(q1)).toEqual([
      {
        tenant_no: 1,
        tenant_class: "approved_test",
        period: "2026-09",
        order_linked: true,
        status: "SENT",
        period_filed: true,
        invoices: 2,
        lines: 2,
        units: 7, // inv1 (6) + inv6 (1, only a REVERSAL row)
      },
      {
        tenant_no: 1,
        tenant_class: "approved_test",
        period: "2026-10",
        order_linked: true,
        status: "DRAFT",
        period_filed: false,
        invoices: 1,
        lines: 1,
        units: 4,
      },
      {
        tenant_no: 2,
        tenant_class: "other",
        period: "2026-09",
        order_linked: false,
        status: "PAID",
        period_filed: false,
        invoices: 1,
        lines: 1,
        units: 2,
      },
    ]);
  });

  it("Q2: the same in one line", async () => {
    const { q2 } = await censusOn();
    expect(q2).toHaveLength(1);
    expect(Object.fromEntries(Object.entries(q2[0]).map(([k, v]) => [k, Number(v)]))).toEqual({
      invoices: 4,
      lines: 4,
      units: 13,
      tenants: 2,
      invoices_in_filed_period: 2,
    });
  });

  it("prints no slug, id or invoice reference: counts and an anonymous number only", async () => {
    const { raw } = await censusOn();
    for (const s of ["qa-fixture-a", "acme-wholesale", "inv1", "ii1", 'ta"', 'tb"']) {
      expect(raw).not.toContain(s);
    }
  });

  it("at 0 (every regulated line booked) both queries answer 0 and no row", async () => {
    const { q1, q2 } = await censusOn(`
      INSERT INTO "RegulatedSalesLedger" VALUES ('lx1', 'ii1', 'SALE'), ('lx4', 'ii4', 'SALE'),
        ('lx6', 'ii6', 'SALE'), ('lx7', 'ii7', 'SALE')
    `);
    expect(q1).toEqual([]);
    expect(Object.fromEntries(Object.entries(q2[0]).map(([k, v]) => [k, Number(v)]))).toEqual({
      invoices: 0,
      lines: 0,
      units: 0,
      tenants: 0,
      invoices_in_filed_period: 0,
    });
  });
});
