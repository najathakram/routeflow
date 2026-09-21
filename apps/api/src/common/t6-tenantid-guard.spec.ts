/**
 * T6 (owner ruling 2026-09-20) — the two migrations that put a `<table>_tenantId_nn` CHECK on the
 * 56 tenant-owned tables whose every writer stamps `tenantId` (the T6 / D5 audit, 2026-09-19).
 * Pins the SHAPE so a later edit cannot quietly widen the guard onto a table that still needs a
 * backfill, drop the NOT VALID-then-VALIDATE order, or slip in a `SET NOT NULL` (which would need
 * the Prisma schema flipped too — a separate PR, see the migration header).
 */
import * as fs from "fs";
import * as path from "path";

const API = path.join(__dirname, "..", "..");
const MIG = path.join(API, "prisma", "migrations");
const read = (dir: string) => fs.readFileSync(path.join(MIG, dir, "migration.sql"), "utf8");
const PART1 = "20260920200000_t6_tenantid_check_not_valid";
const PART2 = "20260920200100_t6_tenantid_check_validate";

// The 19 that need a backfill first and the 6 that stay nullable by design: NEVER in these migrations.
const NOT_YET = [
  "UserPreference", "DeviceToken", "PurchaseOrderItem", "StockAlert", "RouteCustomer",
  "DeliveryBatch", "CustomerTagAssignment", "CustomerPrice", "ReplenishmentSnooze",
  "CommissionAccrual", "CommissionAdjustment", "Transaction", "TransactionItem", "Payment",
  "RecurringInvoice", "RecurringInvoiceItem", "MessageOptOut", "InboundTriage", "AiUsageEvent",
  "User", "RefreshToken", "PaymentCounter", "ExpenseCategory", "VendorBillItem", "AuditLog",
]; // prettier-ignore

const tablesOf = (sql: string, verb: RegExp) =>
  [...sql.matchAll(new RegExp(`^ALTER TABLE "(\\w+)" ${verb.source}`, "gm"))].map((m) => m[1]);

describe("T6 tenantId guard migrations", () => {
  const p1 = read(PART1);
  const p2 = read(PART2);
  const added = tablesOf(p1, /ADD CONSTRAINT "\w+" CHECK \("tenantId" IS NOT NULL\) NOT VALID;/);
  const validated = tablesOf(p2, /VALIDATE CONSTRAINT "\w+";/);

  it("part 1 adds exactly 56 NOT VALID checks, one per table, named <table>_tenantId_nn", () => {
    expect(added).toHaveLength(56);
    expect(new Set(added).size).toBe(56);
    for (const t of added) expect(p1).toContain(`ADD CONSTRAINT "${t}_tenantId_nn" CHECK`);
  });

  it("part 2 validates exactly the same 56 constraints, and nothing else", () => {
    expect(validated).toEqual(added);
    for (const t of validated) expect(p2).toContain(`VALIDATE CONSTRAINT "${t}_tenantId_nn";`);
    expect(p2).not.toMatch(/ADD CONSTRAINT/);
  });

  it("neither migration touches a table that needs a backfill or stays nullable by design", () => {
    for (const t of NOT_YET) {
      expect(added).not.toContain(t);
      expect(validated).not.toContain(t);
    }
  });

  it("never issues SET NOT NULL (that needs the Prisma schema flipped: a separate PR)", () => {
    const statements = (p1 + p2)
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/SET NOT NULL/i);
  });

  it("both parts bound every lock WAIT with a lock_timeout (per statement, not their sum: Prisma runs a file as one transaction)", () => {
    for (const sql of [p1, p2]) {
      expect(sql).toMatch(/SET lock_timeout = '5s';/);
      expect(sql).toMatch(/RESET lock_timeout;/);
    }
  });

  it("the failure recovery is written down in both migrations (resolve --rolled-back, never --applied)", () => {
    for (const sql of [p1, p2]) {
      expect(sql).toMatch(/migrate resolve --rolled-back/);
      expect(sql).toMatch(/NEVER `--applied`/);
    }
  });

  it("every guarded table is a model whose tenantId is STILL nullable in the schema (no drift)", () => {
    const dir = path.join(API, "prisma", "schema");
    const schema = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".prisma"))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    for (const t of added) {
      const body = schema.match(new RegExp(`^model ${t} \\{([\\s\\S]*?)^\\}`, "m"))?.[1];
      expect(body).toBeDefined();
      expect(body).toMatch(/^\s*tenantId\s+String\?/m);
    }
  });
});
