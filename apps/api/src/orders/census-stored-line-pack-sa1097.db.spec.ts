/**
 * SA-1097 census (apps/api/scripts/census-stored-line-pack-sa1097.mjs) on the SA's throwaway fixture (rf-specs
 * decisions/sa/SA-1097-census-fixture.sql, copied below unchanged), real Postgres. The fixture's tables live in a private schema the
 * script's session reads through `search_path`, so the migrated tables are never touched. Pins the totals the SA's SQL gives on it:
 * every Q1 bucket, Q2 by line and by order, and Q3 (qty and money moved, the stock rows the same edit wrote, `split_lost`, live invoices).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

const SCRIPT = path.resolve(__dirname, "../../scripts/census-stored-line-pack-sa1097.mjs");
const SCHEMA = `sa1097_fixture_${randomUUID().slice(0, 8)}`;

const FIXTURE = String.raw`-- Throwaway fixture: only the columns the census reads, shapes taken from Counter's repro.
CREATE TABLE "Tenant"(id text primary key, class text);
CREATE TABLE "Product"(id text primary key, "unitsPerBox" int);
CREATE TABLE "Order"(id text primary key, "tenantId" text, status text);
CREATE TABLE "OrderItem"(id text primary key, "orderId" text, "productId" text, status text, qty numeric(10,3), boxes int, pieces int,
  "unitsPerBox" int, "unitLabel" text, "unitPrice" numeric(10,2), subtotal numeric(10,2), "promoFreeUnits" int);
CREATE TABLE "Invoice"(id text primary key, "orderId" text, status text, total numeric(10,2));
CREATE TABLE "InvoiceItem"(id text primary key, "invoiceId" text, "orderItemId" text);
CREATE TABLE "OrderRevision"(id text primary key, "orderId" text, "revisionNumber" int, snapshot jsonb, source text DEFAULT 'EDIT', "createdAt" timestamp DEFAULT now());
CREATE TABLE "StockMovement"(id text primary key, "productId" text, type text, quantity numeric(10,3), reference text, "createdAt" timestamp DEFAULT now());
INSERT INTO "Tenant" VALUES ('t1','PRODUCTION'),('t2','TEST');
INSERT INTO "Product" VALUES ('p24',24),('p0',NULL);
INSERT INTO "Order" VALUES ('o1','t1','DELIVERED'),('o2','t2','PENDING'),('o3','t1','CANCELLED');
INSERT INTO "OrderItem" VALUES
 ('A','o1','p24','DELIVERED',10,10,0,NULL,NULL,10,100,NULL),   -- own 1, live 24: no_pack_at_sale_live_set
 ('B','o1','p24','DELIVERED',120,10,0,NULL,NULL,10,100,NULL),  -- own 12, live 24: own_differs_live
 ('C','o1','p0','DELIVERED',120,10,0,NULL,NULL,10,100,NULL),   -- own 12, live none: own_pack_live_none
 ('D','o1','p24','DELIVERED',240,10,0,NULL,NULL,10,100,NULL),  -- own 24: own_equals_live
 ('E','o1','p24','DELIVERED',6,0,6,NULL,NULL,12,3,NULL),       -- money fits 24: money_fits_live
 ('F','o1','p24','DELIVERED',6,0,6,NULL,NULL,12,72,NULL),      -- money fits none: money_fits_none_live_set
 ('G','o1','p24','DELIVERED',6,0,6,NULL,NULL,12,50,NULL),      -- fits neither: would_refuse
 ('H','o1','p24','DELIVERED',120,10,0,12,NULL,10,100,NULL),    -- snapshot: excluded
 ('I','o1','p24','DELIVERED',120,10,0,NULL,'Case',10,100,NULL),-- unit label: excluded
 ('J','o1','p24','CANCELLED',120,10,0,NULL,NULL,10,100,NULL),  -- cancelled line: excluded
 ('K','o1','p0','DELIVERED',10,10,0,NULL,NULL,10,100,NULL),    -- own 1, live none: no_pack_at_sale_live_none
 ('L','o3','p24','DELIVERED',120,10,0,NULL,NULL,10,100,NULL),  -- cancelled order: excluded
 ('M','o2','p24','PENDING',120,10,0,NULL,NULL,10,100,NULL),    -- TEST tenant, open: own_differs_live
 ('N','o1','p24','DELIVERED',6,0,6,NULL,NULL,0,0,NULL),        -- price 0, fits both: would_refuse
 ('Q','o1','p24','DELIVERED',12,3,0,NULL,NULL,10,20,1);        -- own 4, one free box: own_differs_live
INSERT INTO "Invoice" VALUES ('v1','o1','SENT',100),('v2','o1','VOID',100),('v3','o1','PAID',300);
INSERT INTO "InvoiceItem" VALUES ('a','v1','A'),('b','v2','B'),('d','v1','D'),('f','v3','F');
INSERT INTO "OrderRevision" VALUES
 ('r1','x1',1,'{"lineItems":[{"productId":"p24","qty":10,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}'),
 ('r2','x1',2,'{"lineItems":[{"productId":"p24","qty":9,"boxes":0,"pieces":9,"unitsPerBox":24,"subtotal":3.75}]}'),   -- hit, own 1 vs 24
 ('r3','x2',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}'),
 ('r4','x2',2,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":12,"subtotal":120}]}'), -- own 12 stamped: right edit, not a hit
 ('r5','x3',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}'),
 ('r6','x3',2,'{"lineItems":[{"productId":"p24","qty":120,"boxes":5,"pieces":0,"unitsPerBox":24,"subtotal":60}]}'),   -- hit, 12 vs 24
 ('r7','x4',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":12,"subtotal":100}]}'),
 ('r8','x4',2,'{"lineItems":[{"productId":"p24","qty":120,"boxes":5,"pieces":0,"unitsPerBox":24,"subtotal":60}]}'),   -- had a snapshot: not this defect
 ('r9','x5',1,'{"lineItems":[{"productId":"p0","qty":120,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}'),
 ('r10','x5',2,'{"lineItems":[{"productId":"p0","qty":120,"boxes":null,"pieces":null,"unitsPerBox":null,"subtotal":1200}]}'); -- hit, split lost, money up
INSERT INTO "Order" VALUES ('x1','t1','DELIVERED'),('x2','t1','DELIVERED'),('x3','t1','DELIVERED'),('x4','t1','DELIVERED'),('x5','t1','DELIVERED');
INSERT INTO "Invoice" VALUES ('v9','x1','SENT',3.75),('v10','x3','VOID',60);
-- Must stay out of Q3: two lines of one product (x6); a later revision that isn't an edit (x7); a snapshot with no line list (x8).
INSERT INTO "OrderRevision" VALUES
 ('r11','x6',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100},{"productId":"p24","qty":5,"boxes":null,"pieces":null,"unitsPerBox":null,"subtotal":50}]}','EDIT'),
 ('r12','x6',2,'{"lineItems":[{"productId":"p24","qty":120,"boxes":5,"pieces":0,"unitsPerBox":24,"subtotal":60},{"productId":"p24","qty":5,"boxes":null,"pieces":null,"unitsPerBox":null,"subtotal":50}]}','EDIT'),
 ('r13','x7',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}','EDIT'),
 ('r14','x7',2,'{"lineItems":[{"productId":"p24","qty":120,"boxes":5,"pieces":0,"unitsPerBox":24,"subtotal":60}]}','SYSTEM_INVOICE_SYNC'),
 ('r15','x8',1,'{"note":"no lines"}','EDIT');
-- A marker as the earlier state does count: its lines show the state before the edit (x9, hit). Plus an invoice item with no line link (v11).
INSERT INTO "OrderRevision" VALUES
 ('r16','x9',1,'{"lineItems":[{"productId":"p24","qty":10,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}','DELIVERED'),
 ('r17','x9',2,'{"lineItems":[{"productId":"p24","qty":10,"boxes":0,"pieces":10,"unitsPerBox":24,"subtotal":5}]}','EDIT');
INSERT INTO "Order" VALUES ('x6','t1','DELIVERED'),('x7','t1','DELIVERED'),('x8','t1','DELIVERED'),('x9','t2','DELIVERED');
-- A2-5's shape with the price unchanged: qty 120 to 240 at the live pack, money the same (x10, hit). The same qty move with no pack change stays out (x11).
INSERT INTO "OrderRevision" VALUES
 ('r18','x10',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}','EDIT'),
 ('r19','x10',2,'{"lineItems":[{"productId":"p24","qty":240,"boxes":10,"pieces":0,"unitsPerBox":24,"subtotal":100}]}','EDIT'),
 ('r20','x11',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}','EDIT'),
 ('r21','x11',2,'{"lineItems":[{"productId":"p24","qty":144,"boxes":12,"pieces":0,"unitsPerBox":12,"subtotal":120}]}','EDIT');
INSERT INTO "Order" VALUES ('x10','t1','DELIVERED'),('x11','t1','DELIVERED');
-- Stock rows. x10: the edit's SALE -120 counts. x3: a row an hour later, a purchase in the window, and another product's row all stay out. x1 (10 to 9) wrote none, the delivered floor.
INSERT INTO "StockMovement" VALUES
 ('m1','p24','SALE',-120,'ORDER:x10',now()),
 ('m2','p24','SALE',-5,'ORDER:x3',now() + interval '1 hour'),
 ('m3','p24','PURCHASE',50,'ORDER:x3',now()),
 ('m4','p0','SALE',-7,'ORDER:x3',now());
INSERT INTO "Invoice" VALUES ('v11','o1','OVERDUE',40);
-- A quotient of 0 (2 boxes, 6 pieces, qty 6, fits neither) goes to the money step and refuses, in Q1 and Q2 alike.
INSERT INTO "OrderItem" VALUES ('R','o1','p24','DELIVERED',6,2,6,NULL,NULL,12,50,NULL);
INSERT INTO "Invoice" VALUES ('v12','o2','DRAFT',50);
INSERT INTO "InvoiceItem" VALUES ('r','v12','R');`;

describeDb("SA-1097 census on the SA's fixture, real Postgres", () => {
  let census: any;

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      await admin.query(`SET search_path TO ${SCHEMA}`);
      await admin.query(FIXTURE);
    } finally {
      await admin.end();
    }
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${SCHEMA}`);
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: scoped.toString() },
      timeout: 120_000,
    });
    if (r.status !== 0) throw new Error(`census exit ${r.status}: ${r.stderr}`);
    census = JSON.parse(r.stdout);
  }, 180_000);

  afterAll(async () => {
    const admin = new Client({ connectionString: requireLocalDatabaseUrl() });
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  const cell = (rows: any[], match: Record<string, unknown>) =>
    rows.find((r) => Object.entries(match).every(([k, v]) => r[k] === v));

  it("Q1: one bucket per class of line, cancelled / snapshot / unit-label lines excluded", () => {
    const got = census.q1.map(
      (r: any) => `${r.tenant_class}:${r.bucket}:${r.order_status}:${r.lines}:${r.line_total}`,
    );
    expect(got).toEqual([
      "PRODUCTION:money_fits_live:DELIVERED:1:3.00",
      "PRODUCTION:money_fits_none_live_set:DELIVERED:1:72.00",
      "PRODUCTION:no_pack_at_sale_live_none:DELIVERED:1:100.00",
      "PRODUCTION:no_pack_at_sale_live_set:DELIVERED:1:100.00",
      "PRODUCTION:own_differs_live:DELIVERED:2:120.00",
      "PRODUCTION:own_equals_live:DELIVERED:1:100.00",
      "PRODUCTION:own_pack_live_none:DELIVERED:1:100.00",
      "PRODUCTION:would_refuse:DELIVERED:3:100.00",
      "TEST:own_differs_live:PENDING:1:100.00",
    ]);
  });

  it("Q2: live invoices holding an exposed line, by line link and by order, void ones left out", () => {
    const got = census.q2.map(
      (r: any) => `${r.via}:${r.tenant_class}:${r.invoice_status}:${r.invoices}:${r.invoice_total}`,
    );
    expect(got).toEqual([
      "by_line:PRODUCTION:DRAFT:1:50.00",
      "by_line:PRODUCTION:PAID:1:300.00",
      "by_line:PRODUCTION:SENT:1:100.00",
      "by_order:PRODUCTION:OVERDUE:1:40.00",
      "by_order:PRODUCTION:PAID:1:300.00",
      "by_order:PRODUCTION:SENT:1:100.00",
      "by_order:TEST:DRAFT:1:50.00",
    ]);
  });

  it("Q3: edits that may already have hit, with the stock totals and split_lost", () => {
    expect(cell(census.q3, { tenant_class: "PRODUCTION" })).toEqual({
      tenant_class: "PRODUCTION",
      line_changes: 4,
      orders: 4,
      tenants: 1,
      fell: 2,
      fell_by: "136.25",
      rose: 1,
      rose_by: "1100",
      qty_moved: 2,
      qty_moved_money_same: 1,
      qty_units_up: "120",
      qty_units_down: "1",
      edits_with_stock_row: 1,
      stock_units_out: "120.000",
      stock_units_back: "0",
      qty_moved_no_stock_row: 1,
      split_lost: 1,
      live_invoices: 1,
    });
    expect(cell(census.q3, { tenant_class: "TEST" })).toMatchObject({
      line_changes: 1,
      fell: 1,
      fell_by: "95",
      split_lost: 0,
      live_invoices: 0,
    });
    expect(census.q3).toHaveLength(2);
  });

  it("names its SQL: the commit and the sha-256 of the SA's file", () => {
    expect(census.spec).toEqual({
      sqlCommit: "1375ac917b11ea85a13190e487e73f5ef548cf56",
      sqlSha256: "9b75d69a820faf304eb60ac3b5fcf9fb8ed1761b8f9635f4883651eb52ecef08",
    });
  });
});
