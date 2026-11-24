import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-1215 set 3 (P-85): "PurchaseOrderReceipt", "PurchaseOrderReceiptLine" and "StockMovement"."receiptLineId" in one
 * additive migration folder. Nothing reads or writes any of it yet. Pins the SQL text, the CHECKs, the FK delete actions,
 * NOT VALID before VALIDATE on the one existing-table FK, and that "StockMovement" gets no index here.
 */
const FOLDER = "20261124000100_po_receipts";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const sql = readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8");
const executable = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const flat = executable.replace(/\s+/g, " ").trim();

const table = (name: string): string => {
  const m = flat.match(
    new RegExp(`CREATE TABLE "${name}" \\((.*?)\\); (?:-- |CREATE|ALTER|COMMIT)`),
  );
  expect(m).not.toBeNull();
  return m![1];
};
const fk = (from: string, col: string, to: string, action: string): string =>
  `ALTER TABLE "${from}" ADD CONSTRAINT "${from}_${col}_fkey" FOREIGN KEY ("${col}") REFERENCES "${to}"("id") ON DELETE ${action} ON UPDATE CASCADE`;

describe("SA-1215 set 3 migration folder (PO receipts)", () => {
  it("sorts after P-40's migration and owns its timestamp", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    expect(FOLDER > "20261124000000_tenant_subscription_price_dates").toBe(true);
    expect(all.filter((n) => n.startsWith("20261124000100"))).toEqual([FOLDER]);
  });

  it("is one bounded transaction", () => {
    expect((executable.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((executable.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(executable).toContain("SET LOCAL lock_timeout = '5s'");
  });

  it("creates the header with tenantId NOT NULL and the key, hash and result columns nullable", () => {
    const body = table("PurchaseOrderReceipt");
    expect(body).toContain('"tenantId" TEXT NOT NULL');
    expect(body).toContain('"poId" TEXT NOT NULL');
    expect(body).toContain('"receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(body).toMatch(/"receivedById" TEXT,/);
    expect(body).toMatch(/"vendorReference" TEXT,/);
    expect(body).toMatch(/"idempotencyKey" TEXT,/);
    expect(body).toMatch(/"requestHash" TEXT,/);
    expect(body).toMatch(/"result" JSONB,/);
    expect(body).toMatch(/"reversesReceiptId" TEXT,/);
  });

  it("creates the line with DECIMAL(10,3) quantities and a zero default for damaged", () => {
    const body = table("PurchaseOrderReceiptLine");
    expect(body).toContain('"tenantId" TEXT NOT NULL');
    expect(body).toContain('"receiptId" TEXT NOT NULL');
    expect(body).toContain('"purchaseOrderItemId" TEXT NOT NULL');
    expect(body).toContain('"qtyArriving" DECIMAL(10,3) NOT NULL,');
    expect(body).toContain('"qtyDamaged" DECIMAL(10,3) NOT NULL DEFAULT 0');
  });

  it("carries the four CHECKs with their exact text", () => {
    expect(flat).toContain(
      `CONSTRAINT "PurchaseOrderReceipt_key_hash_pair" CHECK (("idempotencyKey" IS NULL) = ("requestHash" IS NULL))`,
    );
    expect(flat).toContain(
      `CONSTRAINT "PurchaseOrderReceipt_not_self" CHECK ("reversesReceiptId" <> "id")`,
    );
    expect(flat).toContain(
      `CONSTRAINT "PurchaseOrderReceipt_reversal_keyless" CHECK ("reversesReceiptId" IS NULL OR "idempotencyKey" IS NULL)`,
    );
    expect(flat).toContain(
      `CONSTRAINT "PurchaseOrderReceiptLine_qty_sign" CHECK ("qtyArriving" <> 0 AND (("qtyArriving" > 0 AND "qtyDamaged" >= 0 AND "qtyDamaged" <= "qtyArriving") OR ("qtyArriving" < 0 AND "qtyDamaged" <= 0 AND "qtyDamaged" >= "qtyArriving")))`,
    );
  });

  it("adds the unique indexes: one key per tenant, one reversal per receipt, one line per item per receipt", () => {
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "PurchaseOrderReceipt_tenantId_idempotencyKey_key" ON "PurchaseOrderReceipt"("tenantId", "idempotencyKey")',
    );
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "PurchaseOrderReceipt_reversesReceiptId_key" ON "PurchaseOrderReceipt"("reversesReceiptId")',
    );
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "PurchaseOrderReceiptLine_receiptId_purchaseOrderItemId_key" ON "PurchaseOrderReceiptLine"("receiptId", "purchaseOrderItemId")',
    );
  });

  it("adds the foreign keys with the ruled delete actions", () => {
    expect(flat).toContain(fk("PurchaseOrderReceipt", "tenantId", "Tenant", "RESTRICT"));
    expect(flat).toContain(fk("PurchaseOrderReceipt", "poId", "PurchaseOrder", "CASCADE"));
    expect(flat).toContain(fk("PurchaseOrderReceipt", "receivedById", "User", "SET NULL"));
    expect(flat).toContain(
      fk("PurchaseOrderReceipt", "reversesReceiptId", "PurchaseOrderReceipt", "RESTRICT"),
    );
    expect(flat).toContain(fk("PurchaseOrderReceiptLine", "tenantId", "Tenant", "RESTRICT"));
    expect(flat).toContain(
      fk("PurchaseOrderReceiptLine", "receiptId", "PurchaseOrderReceipt", "CASCADE"),
    );
    expect(flat).toContain(
      fk("PurchaseOrderReceiptLine", "purchaseOrderItemId", "PurchaseOrderItem", "CASCADE"),
    );
  });

  it("adds StockMovement.receiptLineId nullable, with an FK that is NOT VALID first and validated after", () => {
    expect(flat).toContain('ALTER TABLE "StockMovement" ADD COLUMN "receiptLineId" TEXT;');
    expect(flat).toContain(
      `${fk("StockMovement", "receiptLineId", "PurchaseOrderReceiptLine", "SET NULL")} NOT VALID;`,
    );
    const notValid = flat.indexOf("NOT VALID;");
    const validate = flat.indexOf(
      'ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "StockMovement_receiptLineId_fkey";',
    );
    expect(notValid).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(notValid);
    // every statement on StockMovement: the column, the FK, the validate; and no index on it
    expect((executable.match(/ALTER TABLE "StockMovement"/g) ?? []).length).toBe(3);
    expect(executable).not.toMatch(/CREATE (UNIQUE )?INDEX[^;]*ON "StockMovement"/);
  });

  it("is additive: nothing dropped, rewritten or backfilled, no NOT NULL or default added to an existing table", () => {
    expect(executable).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|\bRENAME\b|ADD VALUE|CONCURRENTLY/im,
    );
  });
});
