import { createHash } from "crypto";
import { spawnSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

/**
 * SA-1097 A-8: `--q10-line` of the census script (`apps/api/scripts/census-stored-line-pack-sa1097.mjs`, Q10's July line again) run against
 * the SA's four stacked fixtures (rf-specs decisions/sa/SA-1097-census-fixture.sql, -denominators-fixture.sql, -third-fixture.sql and
 * -q10-line-fixture.sql at 03eb45aa48, LF line endings as filed), each embedded byte for byte below with its sha-256 asserted. They load, in
 * that order, into a throwaway schema of the local test database that this spec creates and drops; it never reads or writes the real
 * tables. The SQL is the script's Q10_LINE_SQL (its sha-256 is pinned by the script spec), split by the script's own splitCensusSql and
 * run in one READ ONLY transaction, as the script does.
 */
const FIXTURE_SHA256 = [
  "8bb675aa98ecbdaa51f8916da6196cd76ed275579cf7c36d5ece0810699feac0",
  "5831ac0f6b86eaa2a09aea73a439ebf5a50b1282b0b0f6bc833513b58fcc54a8",
  "f41e36dc6e1099ee3e6c1ddc2a0902b7b2d1dcb9b0cd8880f1d97f35fd09c34a",
  "b81844e0254dc411bd75de513844f41fc1a6af09839e677ff3865e9fef6527e4",
];
const FIXTURES = [
  String.raw`-- Throwaway fixture: only the columns the census reads, shapes taken from Counter's repro.
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
INSERT INTO "InvoiceItem" VALUES ('r','v12','R');
`,
  String.raw`-- Throwaway fixture, loaded after SA-1097-census-fixture.sql: only what the denominators read beyond the census.
ALTER TABLE "OrderItem" ADD COLUMN "createdAt" timestamp DEFAULT timestamp '2026-10-01';
ALTER TABLE "Order" ADD COLUMN "createdAt" timestamp DEFAULT timestamp '2026-10-01';
INSERT INTO "Tenant" VALUES ('t9','DEMO');
INSERT INTO "Order" VALUES ('n1',NULL,'DELIVERED','2026-10-01'),('old1','t9','DELIVERED','2026-06-01'),('d1','t9','DELIVERED','2026-10-01'),('rev0','t9','DELIVERED','2026-10-01');
INSERT INTO "OrderItem" (id,"orderId","productId",status,qty,boxes,pieces,"unitsPerBox","unitLabel","unitPrice",subtotal,"promoFreeUnits","createdAt") VALUES
 ('d-tenant','n1','p24','DELIVERED',120,10,0,NULL,NULL,10,100,NULL,'2026-10-01'),   -- no tenant, no snapshot
 ('d-free','d1',NULL,'DELIVERED',120,10,0,NULL,NULL,10,100,NULL,'2026-10-01'),      -- free text, no snapshot
 ('d-label','d1','p24','DELIVERED',120,10,0,NULL,'Case',10,100,NULL,'2026-10-01'),  -- label, no snapshot
 ('d-zero','d1','p24','DELIVERED',120,10,0,0,NULL,10,100,NULL,'2026-10-01'),        -- snapshot 0
 ('d-one','d1','p24','DELIVERED',10,10,0,1,NULL,10,100,NULL,'2026-10-01'),          -- snapshot 1
 ('d-good','d1','p24','DELIVERED',240,10,0,24,NULL,10,100,NULL,'2026-10-01'),       -- agrees, equals live
 ('d-wrong','old1','p24','DELIVERED',120,10,0,24,NULL,10,100,NULL,'2026-06-01'),    -- backfill's wrong pack: own 12, snapshot 24, on an old order
 ('d-money','d1','p24','DELIVERED',240,10,0,24,NULL,10,55,NULL,'2026-10-01'),       -- agrees on qty, money doesn't
 ('d-live','d1','p0','DELIVERED',120,10,0,12,NULL,10,100,NULL,'2026-10-01'),        -- snapshot, product has no pack now
 ('d-plain','d1','p24','DELIVERED',5,NULL,NULL,12,NULL,10,50,NULL,'2026-10-01'),    -- no split, snapshot
 ('d-gone','o3','p24','DELIVERED',120,10,0,NULL,NULL,10,100,NULL,'2026-10-01');     -- cancelled order, no snapshot
INSERT INTO "OrderRevision" (id,"orderId","revisionNumber",snapshot,source) VALUES
 ('s1','d1',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":null,"subtotal":100}]}','CHANGE_REQUEST'),
 ('s2','d1',2,'{"lineItems":[{"productId":"p24","qty":120,"boxes":5,"pieces":0,"unitsPerBox":24,"subtotal":60}]}','CHANGE_REQUEST'),  -- at-door hit Q3 can't see
 ('s3','old1',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":5,"pieces":0,"unitsPerBox":24,"subtotal":60}]}','EDIT'),          -- first edit, no earlier state
 ('s4','d1',3,'{"subtotal":1}','SYSTEM_MERGE'),                                                                                       -- no line list
 ('s5','rev0',1,'{"lineItems":[{"productId":"p24","name":"old shape","qty":5}]}','EDIT');                                              -- entry with none of the keys
`,
  String.raw`-- Throwaway fixture, loaded after SA-1097-census-fixture.sql and SA-1097-denominators-fixture.sql: only what the third count reads beyond them.
ALTER TABLE "OrderItem" ADD COLUMN "priceType" text, ADD COLUMN "originalPrice" numeric(10,2);
INSERT INTO "Order" VALUES ('t3a','t9','DELIVERED','2026-10-01'),('t3b','t9','DELIVERED','2026-10-01'),('t3c','t9','DELIVERED','2026-10-01');
INSERT INTO "OrderItem" (id,"orderId","productId",status,qty,boxes,pieces,"unitsPerBox","unitLabel","unitPrice",subtotal,"promoFreeUnits","createdAt","priceType") VALUES
 ('t-plain-ok','t3a','p24','DELIVERED',5,NULL,NULL,24,NULL,10,50,NULL,'2026-10-02','LIST'),     -- plain, snapshot, money is qty x price, on a synced order
 ('t-plain-bad','t3b','p24','DELIVERED',5,NULL,NULL,24,NULL,10,2.08,NULL,'2026-10-02','LIST'),  -- plain, snapshot, money is qty / pack: a hit's mark
 ('t-money-half','t3b','p24','DELIVERED',240,10,0,24,NULL,10,50,NULL,'2026-10-02','LIST');      -- split, money half its own split
INSERT INTO "OrderRevision" (id,"orderId","revisionNumber",snapshot,source) VALUES
 ('t1','t3a',1,'{"lineItems":[{"productId":"p24","qty":5,"boxes":null,"pieces":null,"unitsPerBox":24,"subtotal":50}]}','SYSTEM_INVOICE_SYNC'),
 ('t2','t3c',1,'{"lineItems":[{"productId":"p24","qty":120,"boxes":10,"pieces":0,"unitsPerBox":12,"subtotal":100}]}','EDIT'),
 ('t3','t3c',2,'{"lineItems":[{"productId":"p24","qty":120,"boxes":5,"pieces":0,"unitsPerBox":24,"subtotal":50}]}','EDIT'),     -- pack changed, Q8 can't see it
 ('t4','t3c',3,'{"lineItems":[{"productId":"p24","qty":120,"boxes":null,"pieces":null,"unitsPerBox":null,"subtotal":60}]}','EDIT'); -- split lost, money moved
-- Q12 pieces-only lines: stamped at 2.50 (reads as pieces), no snapshot at 2.50 (pieces, by the live pack), stamped at 60.00 (reads as boxes), pieces 0, one cancelled (not counted).
INSERT INTO "Order" VALUES ('t3d','t9','CONFIRMED','2026-10-01');
INSERT INTO "OrderItem" (id,"orderId","productId",status,qty,boxes,pieces,"unitsPerBox","unitLabel","unitPrice",subtotal,"promoFreeUnits","createdAt","priceType") VALUES
 ('t-po-stamped','t3d','p24','PENDING',6,NULL,6,24,NULL,10,2.50,NULL,'2026-10-02','LIST'),
 ('t-po-nosnap','t3d','p24','PENDING',6,NULL,6,NULL,NULL,10,2.50,NULL,'2026-10-02','LIST'),
 ('t-po-boxes','t3a','p24','DELIVERED',6,NULL,6,24,NULL,10,60,NULL,'2026-10-02','LIST'),
 ('t-po-zero','t3d','p24','PENDING',5,NULL,0,24,NULL,10,50,NULL,'2026-10-02','LIST'),
 ('t-po-cancel','t3d','p24','CANCELLED',6,NULL,6,24,NULL,10,2.50,NULL,'2026-10-02','LIST');
`,
  String.raw`-- Throwaway fixture, loaded after SA-1097-census-fixture.sql, SA-1097-denominators-fixture.sql and SA-1097-third-fixture.sql: only what the A-8 count reads beyond them.
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "deliveredQty" numeric(10,3) DEFAULT 0, ADD COLUMN IF NOT EXISTS "overrideReason" text, ADD COLUMN IF NOT EXISTS "overriddenBy" text;
CREATE TABLE IF NOT EXISTS "Invoice" (id text PRIMARY KEY);
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS "paidAt" timestamp;
CREATE TABLE IF NOT EXISTS "InvoiceItem" (id text PRIMARY KEY);
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "invoiceId" text, ADD COLUMN IF NOT EXISTS "orderItemId" text, ADD COLUMN IF NOT EXISTS subtotal numeric(10,2);
CREATE TABLE IF NOT EXISTS "CreditNote" (id text PRIMARY KEY, "invoiceId" text);
INSERT INTO "Order" VALUES ('t8a','t9','DELIVERED','2026-07-01');
INSERT INTO "OrderItem" (id,"orderId","productId",status,qty,boxes,pieces,"unitsPerBox","unitLabel","unitPrice",subtotal,"promoFreeUnits","createdAt","priceType","originalPrice","deliveredQty","overrideReason") VALUES
 ('t8-over','t8a','p24','PENDING',10,2,0,5,NULL,10,100,NULL,'2026-07-02','MANUAL',10,10,NULL),       -- a box price, money 5x, billed in full, paid, one credit note
 ('t8-piece','t8a','p24','PENDING',10,2,0,5,NULL,2,20,NULL,'2026-07-03','MANUAL',10,10,'typed'),      -- a per-piece price, price 1/5 of the original, money is right, billed in full on a draft
 ('t8-nobill','t8a','p24','PENDING',10,2,0,5,NULL,10,100,NULL,'2026-07-04','MANUAL',10,0,NULL),       -- 5x, but no invoice bills it
 ('t8-void','t8a','p24','PENDING',10,2,0,5,NULL,10,100,NULL,'2026-07-05','MANUAL',NULL,10,NULL),      -- 5x, only a void invoice: no billing, no original price
 ('t8-clean','t8a','p24','PENDING',10,2,0,5,NULL,10,20,NULL,'2026-07-06','MANUAL',10,10,NULL);        -- money fits its split: not printed
INSERT INTO "Invoice" (id,status,"paidAt") VALUES ('i8a','FINALIZED','2026-07-10'),('i8b','DRAFT',NULL),('i8v','VOID',NULL);
INSERT INTO "InvoiceItem" (id,"invoiceId","orderItemId",subtotal) VALUES ('ii1','i8a','t8-over',100),('ii2','i8b','t8-piece',20),('ii3','i8v','t8-void',100),('ii4','i8a','t8-clean',20);
INSERT INTO "CreditNote" VALUES ('c8','i8a');
`,
];

const SCRIPT = path.resolve(__dirname, "../../scripts/census-stored-line-pack-sa1097.mjs");

/** The script's own split of Q10_LINE_SQL: [{ name, sql }]. */
function q10Queries(): Array<{ name: string; sql: string }> {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { Q10_LINE_SQL, splitCensusSql } from "${pathToFileURL(SCRIPT).href}"; console.log(JSON.stringify(splitCensusSql(Q10_LINE_SQL)));`,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  return JSON.parse(res.stdout);
}

describeDb("SA-1097 A-8 Q10 line read on the SA's fixtures", () => {
  it("the embedded fixtures are the SA's files (sha-256)", () => {
    expect(FIXTURES.map((f) => createHash("sha256").update(f).digest("hex"))).toEqual(
      FIXTURE_SHA256,
    );
  });

  it("is one query named q10_line", () => {
    expect(q10Queries().map((q) => q.name)).toEqual(["q10_line"]);
  });

  it("prints the July line's rows as the fixture's comments say, and nothing it must not", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require("pg");
    const client = new Client({ connectionString: requireLocalDatabaseUrl() });
    await client.connect();
    const schema = `a8_q10_${Date.now().toString(36)}`;
    let rows: Array<Record<string, any>> = [];
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path = "${schema}"`);
      for (const f of FIXTURES) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(f);
      }
      const [q] = q10Queries();
      await client.query("BEGIN READ ONLY");
      const res = await client.query(q.sql);
      // one statement: a result array here would mean two statements ran as one
      expect(Array.isArray(res)).toBe(false);
      rows = res.rows;
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }

    // No ids, names, prices or totals print, and at most 20 rows.
    expect(rows.length).toBeLessThanOrEqual(20);
    const printed = new Set(rows.flatMap((r) => Object.keys(r)));
    for (const k of [
      "id",
      "price",
      "subtotal",
      "total",
      "name",
      "billed",
      "original",
      "expected",
    ]) {
      expect(printed.has(k)).toBe(false);
    }

    // The fixture's four July lines (the clean one fits its split, so it is not printed), told apart by what they print.
    const july = rows.filter((r) => r.month === "2026-07");
    expect(july).toHaveLength(4);
    const by = (f: (r: Record<string, any>) => boolean) => july.filter(f);
    const common = {
      tenant_class: "DEMO",
      line_status: "PENDING",
      order_status: "DELIVERED",
      price_type: "MANUAL",
      snap: 5,
      has_author: false,
      ratio_to_own_split: "5.0000",
      qty_per_box: "5.0000",
    };

    // A box price at five times, billed in full, paid, one credit note.
    const over = by((r) => r.price_to_original === "1.0000" && r.credit_notes === 1);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({
      ...common,
      has_reason: false,
      delivered_to_qty: "1.0000",
      invoice_lines: 1,
      invoice_statuses: ["FINALIZED"],
      any_paid: true,
      billed_to_line: "1.0000",
    });

    // A per-piece price: price is a fifth of the original, billed in full on a draft.
    const piece = by((r) => r.price_to_original === "0.2000");
    expect(piece).toHaveLength(1);
    expect(piece[0]).toMatchObject({
      ...common,
      has_reason: true,
      delivered_to_qty: "1.0000",
      invoice_lines: 1,
      invoice_statuses: ["DRAFT"],
      any_paid: false,
      credit_notes: 0,
      billed_to_line: "1.0000",
    });

    // 5x but nothing bills it (nothing delivered).
    const nobill = by((r) => r.delivered_to_qty === "0.0000");
    expect(nobill).toHaveLength(1);
    expect(nobill[0]).toMatchObject({
      ...common,
      has_reason: false,
      price_to_original: "1.0000",
      invoice_lines: 0,
      invoice_statuses: null,
      any_paid: false,
      credit_notes: 0,
      billed_to_line: null,
    });

    // 5x with only a void invoice: no billing, no original price on it.
    const voided = by((r) => r.price_to_original === null);
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({
      ...common,
      has_reason: false,
      delivered_to_qty: "1.0000",
      invoice_lines: 0,
      invoice_statuses: null,
      any_paid: false,
      credit_notes: 0,
      billed_to_line: null,
    });
  });
});
