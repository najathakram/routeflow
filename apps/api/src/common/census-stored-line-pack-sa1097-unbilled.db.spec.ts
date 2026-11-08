import { createHash } from "crypto";
import { spawnSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

/**
 * SA-1098 A-3: `--unbilled` of the SA-1097 census script (`apps/api/scripts/census-stored-line-pack-sa1097.mjs`) run against the SA's
 * own fixture (rf-specs decisions/sa/SA-1098-unbilled-fixture.sql at 29603388, unchanged at f72e1c1678), embedded byte for byte below.
 * The fixture's tables live in a throwaway schema of the local test database that this spec creates and drops; it never reads or
 * writes the real tables. The SQL itself is the script's UNBILLED_SQL (its sha-256 is pinned by the script spec).
 */
const FIXTURE_SHA256 = "58a1e1c31a562e28f4d36a7fd651d48a1e539a5d32ca7b2da8ed508b198d0b49";
const FIXTURE = String.raw`-- Throwaway fixture for SA-1098-unbilled.sql. Fictional rows only.
CREATE TABLE "Tenant" (id text PRIMARY KEY, class text);
CREATE TABLE "Order" (id text PRIMARY KEY, "tenantId" text, status text);
CREATE TABLE "OrderItem" (id text PRIMARY KEY, "orderId" text, status text, "deliveredQty" numeric, "createdAt" timestamp);
CREATE TABLE "Invoice" (id text PRIMARY KEY, "orderId" text, status text, "deliveryBatchId" text);
CREATE TABLE "InvoiceItem" (id text PRIMARY KEY, "invoiceId" text, "orderItemId" text);
INSERT INTO "Tenant" VALUES ('t1','PRODUCTION'),('t2','TEST');
INSERT INTO "Order" VALUES ('o-empty','t1','DELIVERED'),('o-part','t1','DELIVERED'),('o-sent','t1','DELIVERED'),('o-none','t1','DELIVERED'),('o-ok','t1','DELIVERED'),('o-void','t1','DELIVERED'),('o-cancel','t1','CANCELLED'),('o-test','t2','CONFIRMED');
INSERT INTO "OrderItem" VALUES
 ('l-empty-1','o-empty','DELIVERED',10,'2026-10-01'),('l-empty-2','o-empty','DELIVERED',4,'2026-10-01'), -- empty draft: both counted, on_order_with_empty_draft
 ('l-part-1','o-part','DELIVERED',10,'2026-10-02'),('l-part-2','o-part','DELIVERED',4,'2026-10-02'),     -- draft holds line 1: line 2 counted, open_draft_only
 ('l-sent-1','o-sent','DELIVERED',10,'2026-10-03'),('l-sent-2','o-sent','DELIVERED',4,'2026-10-03'),     -- issued with line 1: line 2 counted, has_finalized
 ('l-none','o-none','DELIVERED',3,'2026-10-04'),                                                        -- no invoice at all
 ('l-ok','o-ok','DELIVERED',3,'2026-10-04'),                                                            -- billed: not counted
 ('l-zero','o-ok','DELIVERED',0,'2026-10-04'),                                                          -- delivered 0: not counted
 ('l-cancel-line','o-ok','CANCELLED',3,'2026-10-04'),                                                   -- cancelled line: not counted
 ('l-void','o-void','DELIVERED',3,'2026-10-05'),                                                        -- billed only by a void invoice: counted, no_invoice_at_all
 ('l-cancel-order','o-cancel','PENDING',3,'2026-10-05'),                                                -- cancelled order: not counted
 ('l-test','o-test','PENDING',2,'2026-10-06');                                                          -- TEST class, order not delivered
INSERT INTO "Invoice" VALUES ('i-empty','o-empty','DRAFT',NULL),('i-part','o-part','DRAFT',NULL),('i-sent','o-sent','SENT',NULL),('i-ok','o-ok','DRAFT',NULL),('i-void','o-void','VOID',NULL);
INSERT INTO "InvoiceItem" VALUES ('x1','i-part','l-part-1'),('x2','i-sent','l-sent-1'),('x3','i-ok','l-ok'),('x4','i-void','l-void');
`;

const SCRIPT = path.resolve(__dirname, "../../scripts/census-stored-line-pack-sa1097.mjs");

function unbilledSql(): string {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { UNBILLED_SQL } from "${pathToFileURL(SCRIPT).href}"; console.log(JSON.stringify(UNBILLED_SQL));`,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  return JSON.parse(res.stdout);
}

describeDb("SA-1098 unbilled-lines count on the SA's fixture", () => {
  it("the embedded fixture is the SA's file (sha-256)", () => {
    expect(createHash("sha256").update(FIXTURE).digest("hex")).toBe(FIXTURE_SHA256);
  });

  it("counts each fixture row where its comment says, and leaves the billed, zero, cancelled and cancelled-order lines out", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require("pg");
    const client = new Client({ connectionString: requireLocalDatabaseUrl() });
    await client.connect();
    const schema = `a3_unbilled_${Date.now().toString(36)}`;
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path = "${schema}"`);
      await client.query(FIXTURE);
      await client.query("BEGIN READ ONLY");
      const rows = (await client.query(unbilledSql())).rows;
      await client.query("ROLLBACK");
      expect(rows).toEqual([
        {
          tenant_class: "PRODUCTION",
          lines: 6,
          orders: 5,
          on_delivered_order: 6,
          // the three lines on orders whose only invoice is an open draft: both lines of o-empty (empty draft) and o-part's line 2
          open_draft_only: 3,
          on_order_with_empty_draft: 2,
          has_finalized: 1,
          no_invoice_at_all: 2,
          has_untracked_lines: 0,
          first_line: expect.anything(),
          last_line: expect.anything(),
        },
        {
          tenant_class: "TEST",
          lines: 1,
          orders: 1,
          on_delivered_order: 0,
          open_draft_only: 0,
          on_order_with_empty_draft: 0,
          has_finalized: 0,
          no_invoice_at_all: 1,
          has_untracked_lines: 0,
          first_line: expect.anything(),
          last_line: expect.anything(),
        },
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
});
