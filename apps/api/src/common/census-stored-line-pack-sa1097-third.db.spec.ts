import { createHash } from "crypto";
import { spawnSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

/**
 * SA-1097 A-6 + A-7: `--third` of the census script (`apps/api/scripts/census-stored-line-pack-sa1097.mjs`, Q9 to Q12) run against the
 * SA's three stacked fixtures (rf-specs decisions/sa/SA-1097-census-fixture.sql, -denominators-fixture.sql and -third-fixture.sql at
 * 67dfe0b894), each embedded byte for byte below with its sha-256 asserted. They load, in that order, into a throwaway schema of the local
 * test database that this spec creates and drops; it never reads or writes the real tables. The SQL is the script's THIRD_SQL (its sha-256
 * is pinned by the script spec), split by the script's own splitCensusSql and run one query per READ ONLY transaction, as the script does.
 */
const FIXTURE_SHA256 = [
  "8bb675aa98ecbdaa51f8916da6196cd76ed275579cf7c36d5ece0810699feac0",
  "5831ac0f6b86eaa2a09aea73a439ebf5a50b1282b0b0f6bc833513b58fcc54a8",
  "f41e36dc6e1099ee3e6c1ddc2a0902b7b2d1dcb9b0cd8880f1d97f35fd09c34a",
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
];

const SCRIPT = path.resolve(__dirname, "../../scripts/census-stored-line-pack-sa1097.mjs");

/** The script's own split of THIRD_SQL: [{ name, sql }] for q9..q12. */
function thirdQueries(): Array<{ name: string; sql: string }> {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { THIRD_SQL, splitCensusSql } from "${pathToFileURL(SCRIPT).href}"; console.log(JSON.stringify(splitCensusSql(THIRD_SQL)));`,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
  return JSON.parse(res.stdout);
}

describeDb("SA-1097 third count (Q9 to Q12) on the SA's fixtures", () => {
  it("the embedded fixtures are the SA's files (sha-256)", () => {
    expect(FIXTURES.map((f) => createHash("sha256").update(f).digest("hex"))).toEqual(
      FIXTURE_SHA256,
    );
  });

  it("splits into q9, q10, q11 and q12 (Q10 to Q12 have two-digit markers)", () => {
    expect(thirdQueries().map((q) => q.name)).toEqual(["q9", "q10", "q11", "q12"]);
  });

  it("each query returns what the fixtures' comments say", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require("pg");
    const client = new Client({ connectionString: requireLocalDatabaseUrl() });
    await client.connect();
    const schema = `a7_third_${Date.now().toString(36)}`;
    const rows: Record<string, any[]> = {};
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path = "${schema}"`);
      for (const f of FIXTURES) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(f);
      }
      for (const q of thirdQueries()) {
        // eslint-disable-next-line no-await-in-loop
        await client.query("BEGIN READ ONLY");
        // eslint-disable-next-line no-await-in-loop
        const res = await client.query(q.sql);
        // one statement per query: a result array here would mean two statements ran as one
        expect(Array.isArray(res)).toBe(false);
        rows[q.name] = res.rows;
        // eslint-disable-next-line no-await-in-loop
        await client.query("ROLLBACK");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }

    // Q9: plain lines holding a snapshot: t-plain-ok (on the synced order), t-plain-bad (money is qty / pack) and d-plain.
    expect(rows.q9).toEqual([
      {
        tenant_class: "DEMO",
        plain_snap_lines: 3,
        orders: 3,
        on_sync_order: 1,
        money_is_qty_price: 2,
        money_other: 1,
        snap_equals_live: 2,
        labelled: 0,
        first_at: expect.anything(),
        last_at: expect.anything(),
      },
    ]);

    // Q10: one row per split line whose money differs from its own split, as a ratio (no price or total prints).
    expect(rows.q10.map((r) => r.ratio_to_own_split)).toEqual([
      "0.5500",
      "24.0000",
      "0.5000",
      null,
    ]);
    expect(rows.q10.every((r) => !("subtotal" in r) && !("unit_price" in r))).toBe(true);

    // Q11: order t3c's revisions, t2 to t3 (pack changed 12 to 24) and t3 to t4 (split lost, money moved), source EDIT.
    expect(rows.q11.filter((r) => r.tenant_class === "DEMO" && r.source === "EDIT")).toEqual([
      {
        tenant_class: "DEMO",
        source: "EDIT",
        pairs: 2,
        split_before: 2,
        pack_changed: 1,
        orders_pack_changed: 1,
        split_lost: 1,
        split_lost_money_moved: 1,
      },
    ]);

    // Q12 (A-7): pieces-only lines. 4 lines (the cancelled one is left out), 3 with pieces above 0, 3 stamped, 3 on undelivered orders,
    // 2 whose money reads as pieces (2.50) and 1 as boxes (60.00).
    expect(rows.q12).toEqual([
      {
        tenant_class: "DEMO",
        lines: 4,
        pieces_above_0: 3,
        with_snapshot: 3,
        order_not_delivered: 3,
        money_reads_as_pieces: 2,
        money_reads_as_boxes: 1,
      },
    ]);
  });
});
