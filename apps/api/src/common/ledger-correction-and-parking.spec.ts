/**
 * B660 / B662 (fleet lead + Senior Architect 2026-09-21) — ONE migration: two ADDITIVE, NULLABLE columns on
 * "RegulatedSalesLedger" (a correction row points at the SALE it corrects) and a NEW, EMPTY table
 * "RegulatedLedgerParkedReversal" (a return reversal parked until an operator supplies the split) plus, from B665,
 * a second NEW, EMPTY table "ReturnParkedRestock" (a standard return's restock parked the same way). Pins that the
 * migration stays exactly that: additive, no backfill, no FK except the tenant one, plain indexes. Like the A0
 * unit-column migration it ships to prod BEFORE the PR that adds the schema merges (the image runs
 * `prisma generate` at build time and Prisma selects every scalar, so a client ahead of the columns 500s
 * every read of the ledger).
 */
import * as fs from "fs";
import * as path from "path";

const API = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(API, "prisma", "migrations");
const DIR = "20260921180000_ledger_correction_and_parked_reversals";
const raw = fs.readFileSync(path.join(MIGRATIONS, DIR, "migration.sql"), "utf8");
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, "")) // whole-line AND trailing SQL comments
  .join("\n");
const schemaOf = (file: string) =>
  fs.readFileSync(path.join(API, "prisma", "schema", file), "utf8");
const modelBody = (src: string, name: string) =>
  src.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ?? "";
const compliance = schemaOf("compliance.prisma");
const ledger = modelBody(compliance, "RegulatedSalesLedger");
const parked = modelBody(compliance, "RegulatedLedgerParkedReversal");
const restock = modelBody(compliance, "ReturnParkedRestock");
const tableOf = (name: string) =>
  sql.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
const createTable = tableOf("RegulatedLedgerParkedReversal");
const createRestock = tableOf("ReturnParkedRestock");
const outsideCreateTable = sql.replace(/CREATE TABLE "\w+" \([\s\S]*?\n\);/g, "");
const colsOf = (body: string) =>
  [...body.matchAll(/^\s*"(\w+)" ([A-Z]+(?:\(\d+(?:,\d+)?\))?)( NOT NULL)?/gm)].map(
    (m) => `${m[1]} ${m[2]}${m[3] ? " NOT NULL" : ""}`,
  );

describe("ledger correction columns and parked-reversal table migration", () => {
  it("adds exactly the two nullable ledger columns", () => {
    expect(sql).toMatch(
      /ALTER TABLE "RegulatedSalesLedger" ADD COLUMN "originalSoldAt" TIMESTAMP\(3\),\s*ADD COLUMN "correctsEntryId" TEXT;/,
    );
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(2);
    expect(sql.match(/ALTER TABLE "RegulatedSalesLedger"/g)).toHaveLength(1);
  });

  it("creates exactly two new tables, with exactly the agreed columns", () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(colsOf(createRestock)).toEqual([
      "id TEXT NOT NULL",
      "tenantId TEXT NOT NULL",
      "returnId TEXT NOT NULL",
      "returnItemId TEXT NOT NULL",
      "productId TEXT NOT NULL",
      "returnedQty DECIMAL(10,3) NOT NULL",
      "reason TEXT NOT NULL",
      "createdAt TIMESTAMP(3) NOT NULL",
      "resolvedAt TIMESTAMP(3)",
      "resolvedById TEXT",
      "unitsPerBoxSupplied INTEGER",
      "resolvedMovementId TEXT",
    ]);
    expect(createRestock).not.toMatch(/"status"/i);
    expect(colsOf(createTable)).toEqual([
      "id TEXT NOT NULL",
      "tenantId TEXT NOT NULL",
      "returnId TEXT NOT NULL",
      "orderId TEXT NOT NULL",
      "orderItemId TEXT",
      "saleEntryId TEXT NOT NULL",
      "returnedPieces DECIMAL(10,3) NOT NULL",
      "reason TEXT NOT NULL",
      "periodBucket TEXT NOT NULL",
      "createdAt TIMESTAMP(3) NOT NULL",
      "resolvedAt TIMESTAMP(3)",
      "resolvedById TEXT",
      "unitsPerBoxSupplied INTEGER",
      "resolvedEntryId TEXT",
    ]);
    // parked <=> resolvedAt IS NULL: there is no second source of truth
    expect(createTable).not.toMatch(/"status"/i);
  });

  it("returnedPieces has the SAME type as ReturnItem.qty, and unitsPerBoxSupplied is an Int", () => {
    const returnItem = modelBody(schemaOf("sales.prisma"), "ReturnItem");
    const qtyType = returnItem.match(/^\s*qty\s+Decimal\s+@db\.Decimal\((\d+),\s*(\d+)\)/m);
    expect(qtyType).not.toBeNull();
    expect(createTable).toContain(
      `"returnedPieces" DECIMAL(${qtyType![1]},${qtyType![2]}) NOT NULL`,
    );
    expect(parked).toMatch(
      new RegExp(`returnedPieces\\s+Decimal\\s+@db\\.Decimal\\(${qtyType![1]}, ${qtyType![2]}\\)`),
    );
    expect(parked).toMatch(/^\s*unitsPerBoxSupplied\s+Int\?/m);
    // ReturnParkedRestock.returnedQty is the typed ReturnItem.qty, unchanged
    expect(createRestock).toContain(
      `"returnedQty" DECIMAL(${qtyType![1]},${qtyType![2]}) NOT NULL`,
    );
    expect(restock).toMatch(
      new RegExp(`returnedQty\\s+Decimal\\s+@db\\.Decimal\\(${qtyType![1]}, ${qtyType![2]}\\)`),
    );
    expect(restock).toMatch(/^\s*unitsPerBoxSupplied\s+Int\?/m);
  });

  it("is additive OUTSIDE the new table: no NOT NULL, DEFAULT, UPDATE, DROP, INSERT or backfill", () => {
    expect(outsideCreateTable).not.toMatch(/NOT NULL|DEFAULT/i);
    // (the FK's "ON DELETE CASCADE ON UPDATE CASCADE" is referential-action syntax, not a data statement)
    expect(sql).not.toMatch(/INSERT INTO|UPDATE "|DELETE FROM|TRUNCATE|DROP (TABLE|COLUMN|INDEX)/i);
  });

  it("has exactly five plain indexes: the ledger pointer, each parked table's (tenantId, resolvedAt), UNIQUE (returnId, saleEntryId) and UNIQUE (returnItemId)", () => {
    expect(sql).toMatch(
      /CREATE INDEX "RegulatedSalesLedger_correctsEntryId_idx" ON "RegulatedSalesLedger"\("correctsEntryId"\);/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "RegulatedLedgerParkedReversal_tenantId_resolvedAt_idx" ON "RegulatedLedgerParkedReversal"\("tenantId", "resolvedAt"\);/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "RegulatedLedgerParkedReversal_returnId_saleEntryId_key" ON "RegulatedLedgerParkedReversal"\("returnId", "saleEntryId"\);/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "ReturnParkedRestock_tenantId_resolvedAt_idx" ON "ReturnParkedRestock"\("tenantId", "resolvedAt"\);/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "ReturnParkedRestock_returnItemId_key" ON "ReturnParkedRestock"\("returnItemId"\);/,
    );
    expect(sql.match(/CREATE\s+(UNIQUE\s+)?INDEX/gi)).toHaveLength(5);
    // Prisma runs the file in one transaction: CONCURRENTLY would fail
    expect(sql).not.toMatch(/CONCURRENTLY/i);
  });

  it("the ONLY foreign keys are the two tenant ones (ON DELETE CASCADE); no FK on any pointer", () => {
    expect(sql.match(/REFERENCES/g)).toHaveLength(2);
    expect(sql).toMatch(
      /ALTER TABLE "ReturnParkedRestock" ADD CONSTRAINT "ReturnParkedRestock_tenantId_fkey" FOREIGN KEY \("tenantId"\) REFERENCES "Tenant"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE;/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "RegulatedLedgerParkedReversal" ADD CONSTRAINT "RegulatedLedgerParkedReversal_tenantId_fkey" FOREIGN KEY \("tenantId"\) REFERENCES "Tenant"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE;/,
    );
    expect(sql).not.toMatch(
      /FOREIGN KEY \("(saleEntryId|resolvedEntryId|returnId|orderId|orderItemId|returnItemId|productId|resolvedMovementId)"\)/,
    );
  });

  it("bounds the lock wait with SET LOCAL (this transaction only), before the first statement", () => {
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(sql.indexOf("SET LOCAL lock_timeout")).toBeLessThan(sql.indexOf("ALTER TABLE"));
    // a bare SET would outlive the migration's transaction on a pooled connection (B634)
    expect(sql).not.toMatch(/^\s*SET lock_timeout|RESET lock_timeout/im);
  });

  it("sorts after the latest earlier migration; the header keeps ship-first, the empty-table note and Rollback visible", () => {
    expect(DIR > "20260920220100_t6_tenantid_check_validate").toBe(true);
    expect(raw).toMatch(/apply to prod BEFORE the PR that adds these fields/);
    expect(raw).toMatch(/NEW, EMPTY table/);
    expect(raw).toMatch(
      /Rollback[\s\S]*DROP TABLE "ReturnParkedRestock"[\s\S]*DROP TABLE "RegulatedLedgerParkedReversal"/,
    );
  });

  it("the Prisma schema declares the two ledger fields (optional, same type as soldAt) and the index", () => {
    expect(ledger).toMatch(/^\s*originalSoldAt\s+DateTime\?\s*$/m);
    expect(ledger).toMatch(/^\s*correctsEntryId\s+String\?\s*$/m);
    expect(ledger).toMatch(/^\s*@@index\(\[correctsEntryId\]\)/m);
    expect(ledger).toMatch(/^\s*soldAt\s+DateTime\s*$/m);
    expect(ledger).not.toMatch(/originalSoldAt[^\n]*@db\./);
  });

  it("the Prisma schema declares the parked model: tenant cascade relation, unique, index, no other relation", () => {
    expect(parked).not.toBe("");
    expect(parked).toMatch(
      /^\s*tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/m,
    );
    expect(parked).toMatch(/^\s*@@unique\(\[returnId, saleEntryId\]\)/m);
    expect(parked).toMatch(/^\s*@@index\(\[tenantId, resolvedAt\]\)/m);
    expect(parked.match(/@relation/g)).toHaveLength(1);
    expect(parked).not.toMatch(/^\s*status\s/m);
  });

  it("the ReturnParkedRestock model: tenant cascade relation, UNIQUE(returnItemId), index, no other relation, no status", () => {
    expect(restock).not.toBe("");
    expect(restock).toMatch(
      /^\s*tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/m,
    );
    expect(restock).toMatch(/^\s*@@unique\(\[returnItemId\]\)/m);
    expect(restock).toMatch(/^\s*@@index\(\[tenantId, resolvedAt\]\)/m);
    expect(restock.match(/@relation/g)).toHaveLength(1);
    expect(restock).not.toMatch(/^\s*status\s/m);
  });

  it("the model is registered where a new tenant table silently goes wrong: the Tenant inverse and MODEL_DOMAIN", () => {
    expect(modelBody(schemaOf("tenancy.prisma"), "Tenant")).toMatch(
      /^\s*\w+\s+RegulatedLedgerParkedReversal\[\]/m,
    );
    expect(modelBody(schemaOf("tenancy.prisma"), "Tenant")).toMatch(
      /^\s*\w+\s+ReturnParkedRestock\[\]/m,
    );
    const split = fs.readFileSync(path.join(API, "scripts", "split-prisma-schema.mjs"), "utf8");
    expect(split).toMatch(/^\s*RegulatedLedgerParkedReversal: "compliance",/m);
    expect(split).toMatch(/^\s*ReturnParkedRestock: "compliance",/m);
  });
});
