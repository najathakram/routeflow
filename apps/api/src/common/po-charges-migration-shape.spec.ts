import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import {
  PURCHASE_ORDER_CHARGE_BASIS_VALUES,
  PURCHASE_ORDER_CHARGE_KIND_VALUES,
} from "@routeflow/types";

/**
 * SA-1215 set 4 (P-85): the two charge enums, "PurchaseOrderCharge" and "PurchaseOrderChargeAllocation" in one additive
 * migration folder. No existing table is touched. Pins the SQL text, the CHECKs and the FK delete actions.
 */
const FOLDER = "20261124000200_po_charges";
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
const enumValues = (name: string): string[] => {
  const m = flat.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\);`));
  expect(m).not.toBeNull();
  return m![1].split(",").map((v) => v.trim().replace(/'/g, ""));
};

describe("SA-1215 set 4 migration folder (PO charges)", () => {
  it("sorts after set 3 and owns its timestamp", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    expect(FOLDER > "20261124000100_po_receipts").toBe(true);
    expect(all.filter((n) => n.startsWith("20261124000200"))).toEqual([FOLDER]);
  });

  it("is one bounded transaction", () => {
    expect((executable.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((executable.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(executable).toContain("SET LOCAL lock_timeout = '5s'");
  });

  it("creates the two enums with exactly the ruled values, matching the shared mirrors", () => {
    expect(enumValues("PurchaseOrderChargeKind")).toEqual(["ESTIMATE", "ACTUAL"]);
    expect(enumValues("PurchaseOrderChargeBasis")).toEqual(["VALUE", "QUANTITY"]);
    expect([...PURCHASE_ORDER_CHARGE_KIND_VALUES]).toEqual(enumValues("PurchaseOrderChargeKind"));
    expect([...PURCHASE_ORDER_CHARGE_BASIS_VALUES]).toEqual(enumValues("PurchaseOrderChargeBasis"));
  });

  it("creates the charge with money at DECIMAL(10,2), tenantId NOT NULL, and no stock link or posted-movement column", () => {
    const body = table("PurchaseOrderCharge");
    expect(body).toContain('"tenantId" TEXT NOT NULL');
    expect(body).toContain('"poId" TEXT NOT NULL');
    expect(body).toMatch(/"vendorBillId" TEXT,/);
    expect(body).toContain('"kind" "PurchaseOrderChargeKind" NOT NULL');
    expect(body).toContain(`"basis" "PurchaseOrderChargeBasis" NOT NULL DEFAULT 'VALUE'`);
    expect(body).toMatch(/"label" TEXT,/);
    expect(body).toContain('"amount" DECIMAL(10,2) NOT NULL,');
    expect(body).toContain('"taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0');
    expect(body).toMatch(/"voidedAt" TIMESTAMP\(3\),/);
    expect(body).not.toMatch(/receiptLineId|postedMovementId|updatedAt/);
  });

  it("creates the allocation with a DECIMAL(10,2) amount and no receipt-line column", () => {
    const body = table("PurchaseOrderChargeAllocation");
    expect(body).toContain('"tenantId" TEXT NOT NULL');
    expect(body).toContain('"chargeId" TEXT NOT NULL');
    expect(body).toContain('"purchaseOrderItemId" TEXT NOT NULL');
    expect(body).toContain('"amount" DECIMAL(10,2) NOT NULL');
    expect(body).not.toMatch(/receiptLineId/);
  });

  it("carries the five CHECKs with their exact text", () => {
    expect(flat).toContain(
      `CONSTRAINT "PurchaseOrderCharge_actual_has_bill" CHECK (("kind" = 'ACTUAL') = ("vendorBillId" IS NOT NULL))`,
    );
    expect(flat).toContain(`CONSTRAINT "PurchaseOrderCharge_amount_pos" CHECK ("amount" > 0)`);
    expect(flat).toContain(`CONSTRAINT "PurchaseOrderCharge_tax_nonneg" CHECK ("taxAmount" >= 0)`);
    expect(flat).toContain(
      `CONSTRAINT "PurchaseOrderCharge_not_self" CHECK ("reversesChargeId" <> "id")`,
    );
    expect(flat).toContain(
      `CONSTRAINT "PurchaseOrderChargeAllocation_amount_nonneg" CHECK ("amount" >= 0)`,
    );
  });

  it("guards every NUMERIC column against NaN (SA-816 (d)1), which the sign CHECKs let through", () => {
    for (const [t, col] of [
      ["PurchaseOrderCharge", "amount"],
      ["PurchaseOrderCharge", "taxAmount"],
      ["PurchaseOrderChargeAllocation", "amount"],
    ]) {
      expect(flat).toContain(`CONSTRAINT "${t}_${col}_not_nan" CHECK ("${col}" <> 'NaN'::numeric)`);
    }
  });

  it("adds the unique indexes: one replacement per charge, one share per charge per item", () => {
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "PurchaseOrderCharge_reversesChargeId_key" ON "PurchaseOrderCharge"("reversesChargeId")',
    );
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "PurchaseOrderChargeAllocation_chargeId_purchaseOrderItemId_key" ON "PurchaseOrderChargeAllocation"("chargeId", "purchaseOrderItemId")',
    );
  });

  it("adds the foreign keys with the ruled delete actions", () => {
    expect(flat).toContain(fk("PurchaseOrderCharge", "tenantId", "Tenant", "RESTRICT"));
    expect(flat).toContain(fk("PurchaseOrderCharge", "poId", "PurchaseOrder", "CASCADE"));
    expect(flat).toContain(fk("PurchaseOrderCharge", "vendorBillId", "VendorBill", "RESTRICT"));
    expect(flat).toContain(
      fk("PurchaseOrderCharge", "reversesChargeId", "PurchaseOrderCharge", "RESTRICT"),
    );
    expect(flat).toContain(fk("PurchaseOrderCharge", "voidedById", "User", "SET NULL"));
    expect(flat).toContain(fk("PurchaseOrderCharge", "createdById", "User", "SET NULL"));
    expect(flat).toContain(fk("PurchaseOrderChargeAllocation", "tenantId", "Tenant", "RESTRICT"));
    expect(flat).toContain(
      fk("PurchaseOrderChargeAllocation", "chargeId", "PurchaseOrderCharge", "CASCADE"),
    );
    expect(flat).toContain(
      fk("PurchaseOrderChargeAllocation", "purchaseOrderItemId", "PurchaseOrderItem", "CASCADE"),
    );
  });

  it("is additive and touches no existing table except through foreign keys on the new ones", () => {
    expect(executable).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|ADD COLUMN|\bRENAME\b|ADD VALUE|CONCURRENTLY/im,
    );
    const altered = [...executable.matchAll(/ALTER TABLE "([A-Za-z]+)"/g)].map((m) => m[1]);
    for (const t of altered) expect(t).toMatch(/^PurchaseOrderCharge(Allocation)?$/);
  });
});
