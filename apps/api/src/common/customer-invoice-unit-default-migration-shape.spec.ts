import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { INVOICE_UNIT_DEFAULT_VALUES } from "@routeflow/types";

/**
 * SA-827 PR2: the ONE additive migration folder for Customer.invoiceUnitDefault, read at test time and pinned by shape.
 * A new enum plus ONE NOT NULL column with a constant default (metadata-only on PG >= 11: every existing customer reads
 * LEGACY, which is today's invoices). Never a DROP, RENAME, ALTER TYPE, ALTER COLUMN or row UPDATE; no other table.
 */
const FOLDER = "20261020120000_customer_invoice_unit_default";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const raw = readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const stmts = sql
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim())
  .filter(Boolean);

describe("customer invoice unit default migration shape (SA-827)", () => {
  it("is on disk and sorts after every earlier folder", () => {
    const folders = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_/.test(f));
    expect(folders).toContain(FOLDER);
    expect(FOLDER > "20261016120000_units_prices_v2_schema").toBe(true);
  });

  it("is one transaction with a bounded lock_timeout right after BEGIN", () => {
    expect(stmts[0]).toBe("BEGIN");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(stmts[stmts.length - 1]).toBe("COMMIT");
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
  });

  it("creates the enum with exactly the shared values, in order", () => {
    const create = stmts.find((s) => s.startsWith('CREATE TYPE "InvoiceUnitDefault"'));
    expect(create).toBeDefined();
    const values = [...create!.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]);
    expect(values).toEqual([...INVOICE_UNIT_DEFAULT_VALUES]);
  });

  it('adds "Customer"."invoiceUnitDefault" NOT NULL DEFAULT \'LEGACY\' (the constant default is the backfill)', () => {
    const alter = stmts.filter((s) => s.startsWith("ALTER TABLE"));
    expect(alter).toHaveLength(1);
    expect(alter[0]).toBe(
      `ALTER TABLE "Customer" ADD COLUMN "invoiceUnitDefault" "InvoiceUnitDefault" NOT NULL DEFAULT 'LEGACY'`,
    );
  });

  it("is additive only and touches no other table", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TYPE\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b|\bCREATE\s+TABLE\b/i);
    const tables = [...sql.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(
      tables.filter(
        (t) => t !== "Customer" && t !== "InvoiceUnitDefault" && t !== "invoiceUnitDefault",
      ),
    ).toEqual([]);
  });

  it("documents purpose, SA-827, deploy-day behavior and the rollback in the header", () => {
    const header = raw
      .split("\n")
      .filter((l) => l.startsWith("--"))
      .join("\n");
    expect(header).toMatch(/SA-827/);
    expect(header).toMatch(/LEGACY/);
    expect(header).toMatch(/-- ALTER TABLE "Customer" DROP COLUMN "invoiceUnitDefault"/);
    expect(header).toMatch(/DROP TYPE "InvoiceUnitDefault"/);
  });
});
