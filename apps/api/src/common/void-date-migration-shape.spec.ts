import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-1208 M1-15: "Invoice"."voidedAt" and "InvoicePayment"."voidedAt", two nullable TIMESTAMP(3) columns in one additive
 * migration folder. No default and no backfill: rows voided earlier carry no date. Pins the SQL text.
 */
const FOLDER = "20261122000100_void_date";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const sql = readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8");
const executable = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("SA-1208 M1-15 migration folder", () => {
  it("sorts after the newest earlier migration and owns its timestamp", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    expect(FOLDER > "20261121000100_tenant_plan_core_all_in").toBe(true);
    expect(all.filter((n) => n.startsWith("20261122000100"))).toEqual([FOLDER]);
  });

  it("is one bounded transaction", () => {
    expect((executable.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((executable.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(executable).toContain("SET LOCAL lock_timeout = '5s'");
  });

  it("adds exactly the two nullable TIMESTAMP(3) columns, no default", () => {
    const flat = squash(executable);
    expect(flat).toContain(`ALTER TABLE "Invoice" ADD COLUMN "voidedAt" TIMESTAMP(3);`);
    expect(flat).toContain(`ALTER TABLE "InvoicePayment" ADD COLUMN "voidedAt" TIMESTAMP(3);`);
    expect((executable.match(/ALTER TABLE/g) ?? []).length).toBe(2);
    expect(executable).not.toMatch(/\bNOT NULL\b|\bDEFAULT\b/i);
  });

  it("is additive: nothing dropped, rewritten, backfilled, constrained or indexed", () => {
    expect(executable).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|\bRENAME\b|\bCREATE (UNIQUE )?INDEX\b|\bCREATE TABLE\b|\bCONSTRAINT\b/im,
    );
  });
});
