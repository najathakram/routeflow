import { createHash } from "crypto";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

/**
 * SA-1097 A-9: `--q10-owner` of the census script (`apps/api/scripts/census-stored-line-pack-sa1097.mjs`) run against the SA's five
 * stacked fixtures (rf-specs decisions/sa/SA-1097-census-fixture.sql, -denominators-fixture.sql, -third-fixture.sql and
 * -q10-line-fixture.sql at 03eb45aa48, then -q10-owner-fixture.sql at f65160b0dc, LF line endings as filed), each embedded byte for byte
 * below with its sha-256 asserted. They load, in that order, into a throwaway schema of the local test database that this spec creates
 * and drops; it never reads or writes the real tables. Every name in them is made up. The child process runs the script's own
 * runCensus (read-only session, the one query) and writeOwnerRead into a temp directory, never the repo's local-assets.
 */
const FIXTURE_SHA256 = [
  "8bb675aa98ecbdaa51f8916da6196cd76ed275579cf7c36d5ece0810699feac0",
  "5831ac0f6b86eaa2a09aea73a439ebf5a50b1282b0b0f6bc833513b58fcc54a8",
  "f41e36dc6e1099ee3e6c1ddc2a0902b7b2d1dcb9b0cd8880f1d97f35fd09c34a",
  "b81844e0254dc411bd75de513844f41fc1a6af09839e677ff3865e9fef6527e4",
  "ec50955fb9064e73e8f0efe785c3a0e010707eb5a99810bc158d896b3be986da",
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
  String.raw`-- Throwaway fixture, loaded after SA-1097-census-fixture.sql, -denominators-fixture.sql, -third-fixture.sql and -q10-line-fixture.sql. Made-up names only.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS name text;
CREATE TABLE IF NOT EXISTS "Customer" (id text PRIMARY KEY, "businessName" text);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "customerId" text, ADD COLUMN IF NOT EXISTS "orderNumber" text;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "updatedAt" timestamp DEFAULT '2026-07-05';
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "invoiceNumber" text, ADD COLUMN IF NOT EXISTS "issueDate" timestamp, ADD COLUMN IF NOT EXISTS total numeric(10,2);
UPDATE "Tenant" SET name = 'Acme Wholesale' WHERE id = 't9';
INSERT INTO "Customer" VALUES ('c8','Acme Corner Store');
UPDATE "Order" SET "customerId" = 'c8', "orderNumber" = 'ACME-1' WHERE id = 't8a';
UPDATE "Invoice" SET "invoiceNumber" = 'INV-1', "issueDate" = '2026-07-08', total = 120 WHERE id = 'i8a';
UPDATE "Product" SET name = 'Acme Widget' WHERE id = 'p24';
-- The fixture's t8-over is the one line: 2 boxes of 5, price 10, was 10; make it a raise like the real row's shape.
UPDATE "OrderItem" SET "unitPrice" = 9.5, "originalPrice" = 9, subtotal = 95 WHERE id = 't8-over';
-- Two other lines of the product at their own split, and one that doesn't fit.
INSERT INTO "OrderItem" (id,"orderId","productId",status,qty,boxes,pieces,"unitsPerBox","unitLabel","unitPrice",subtotal,"promoFreeUnits","createdAt","priceType") VALUES
 ('t8-peer1','t8a','p24','DELIVERED',10,2,0,5,NULL,9,18,NULL,'2026-07-01','LIST'),
 ('t8-peer2','t8a','p24','DELIVERED',15,3,0,5,NULL,9,27,NULL,'2026-07-01','LIST');
-- Not the one line: a MANUAL split on no invoice (t8-nobill stays), and a void-only one (t8-void has no original price).
`,
];

const SCRIPT = path.resolve(__dirname, "../../scripts/census-stored-line-pack-sa1097.mjs");

type Outcome = {
  code: number;
  printed: string[];
  count: number;
  file: { q10_owner: Array<Record<string, any>> } | null;
};

/** Loads the five fixtures into a fresh schema, runs `mutate` on it, runs the owner read in a child process, drops the schema. */
async function ownerRead(mutate = ""): Promise<Outcome> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("pg");
  const url = requireLocalDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  const schema = `a9_owner_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owner-read-"));
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path = "${schema}"`);
    for (const f of FIXTURES) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(f);
    }
    if (mutate) await client.query(mutate);
    const dir = path.join(tmp, "local-assets");
    const code = `
      import { createRequire } from "node:module";
      import fs from "node:fs";
      import { runCensus, writeOwnerRead, OWNER_OUT_NAME } from "${pathToFileURL(SCRIPT).href}";
      const { Client } = createRequire("${pathToFileURL(SCRIPT).href}")("pg");
      const c = new Client({ connectionString: process.env.OWNER_READ_URL });
      await c.connect();
      await c.query('SET search_path = "' + process.env.OWNER_READ_SCHEMA + '"');
      const census = await runCensus(c, { q10Owner: true });
      const printed = [];
      const code = writeOwnerRead(census, { dir: process.env.OWNER_READ_DIR, print: (...a) => printed.push(a.join(" ")) });
      await c.end();
      const file = process.env.OWNER_READ_DIR + "/" + OWNER_OUT_NAME;
      console.log(JSON.stringify({ code, printed, count: census.q10_owner.length, file: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null }));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { ...process.env, OWNER_READ_URL: url, OWNER_READ_SCHEMA: schema, OWNER_READ_DIR: dir },
    });
    if (res.status !== 0) throw new Error(res.stderr || `exit ${res.status}`);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  }
}

describeDb("SA-1097 A-9 owner read on the SA's fixtures", () => {
  const NAMES = ["Acme Wholesale", "Acme Corner Store", "ACME-1", "INV-1", "Acme Widget"];

  it("the embedded fixtures are the SA's files (sha-256)", () => {
    expect(FIXTURES.map((f) => createHash("sha256").update(f).digest("hex"))).toEqual(
      FIXTURE_SHA256,
    );
  });

  it("exactly one row: the July line with its business, customer, invoice and amounts goes to the file; stdout says only the count and path", async () => {
    const r = await ownerRead();
    expect(r.count).toBe(1);
    expect(r.code).toBe(0);
    expect(r.printed).toHaveLength(1);
    expect(r.printed[0]).toMatch(
      /q10_owner rows 1 written to .*sa1097-q10-owner-2026-11-03\.json$/,
    );
    for (const n of NAMES) expect(r.printed.join("\n")).not.toContain(n);

    const row = r.file?.q10_owner[0] as Record<string, any>;
    expect(r.file?.q10_owner).toHaveLength(1);
    expect(row).toMatchObject({
      business: "Acme Wholesale",
      customer: "Acme Corner Store",
      order_number: "ACME-1",
      invoice_number: "INV-1",
      product: "Acme Widget",
      boxes: 2,
      units_per_box: 5,
    });
    // 9.00 raised to 9.50, line 95.00, 19.00 at its own split, difference 76.00
    expect(
      [
        row.price_before_edit,
        row.price,
        row.line_total,
        row.total_at_its_split,
        row.difference,
      ].map(Number),
    ).toEqual([9, 9.5, 95, 19, 76]);
    // the two MANUAL rows the read must leave out (no invoice, void-only) stayed out
    expect(r.file?.q10_owner.map((x) => x.order_number)).toEqual(["ACME-1"]);
  });

  it("no row (the invoice is void): nothing is written, the count is printed", async () => {
    const r = await ownerRead(`UPDATE "Invoice" SET status = 'VOID' WHERE id = 'i8a'`);
    expect(r.count).toBe(0);
    expect(r.code).toBe(3);
    expect(r.file).toBeNull();
    expect(r.printed).toEqual([
      expect.stringMatching(/q10_owner rows 0; expected exactly 1, nothing written$/),
    ]);
  });

  it("two rows (a second line qualifies): nothing is written, the count is printed, no name", async () => {
    const r = await ownerRead(
      `INSERT INTO "InvoiceItem" (id,"invoiceId","orderItemId",subtotal) VALUES ('ii9','i8a','t8-nobill',100)`,
    );
    expect(r.count).toBe(2);
    expect(r.code).toBe(3);
    expect(r.file).toBeNull();
    expect(r.printed).toEqual([
      expect.stringMatching(/q10_owner rows 2; expected exactly 1, nothing written$/),
    ]);
    for (const n of NAMES) expect(r.printed.join("\n")).not.toContain(n);
  });
});
