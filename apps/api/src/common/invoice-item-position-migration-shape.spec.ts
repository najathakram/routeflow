import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * W-1187 PR-1: `InvoiceItem.position`, the invoice line's slot, as one additive migration folder.
 *
 * Nothing in the app reads or writes the column in this PR (the copier contract carries it as an `unfiled` gap until
 * PR-1c), so the folder deploys to production first (L-184) with no code depending on it. It has NO default and NO
 * backfill (owner Q2, "Leave them"): a default of 0 would tie every legacy line and silently lose the A-Z order a
 * legacy invoice keeps rendering through the SA-1058 comparator.
 */
const FOLDER = "20261109020000_invoice_item_position";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const SCHEMA_DIR = join(__dirname, "..", "..", "prisma", "schema");

const sql = readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8");
const executable = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("W-1187 PR-1 migration folder", () => {
  it("sorts after the previous newest migration and owns its timestamp", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    expect(FOLDER > "20261107000000_tenant_ai_monthly_cap").toBe(true);
    expect(all.filter((n) => n.startsWith("20261109020000"))).toEqual([FOLDER]);
  });

  it("is one bounded transaction", () => {
    expect((executable.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((executable.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(executable).toContain("SET LOCAL lock_timeout = '5s'");
  });

  it("is additive: nothing dropped, rewritten, backfilled or defaulted", () => {
    expect(executable).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|\bRENAME\b|\bDEFAULT\b|CREATE INDEX/im,
    );
  });

  it("adds one nullable INTEGER column to InvoiceItem, and one CHECK, added NOT VALID", () => {
    expect(squash(executable)).toContain(
      `ALTER TABLE "InvoiceItem" ADD COLUMN "position" INTEGER, ADD CONSTRAINT "InvoiceItem_position_nonneg_chk" CHECK ("position" IS NULL OR "position" >= 0) NOT VALID;`,
    );
    expect(executable).not.toMatch(/"position" INTEGER\s+NOT NULL/i);
    expect((executable.match(/ADD COLUMN/g) ?? []).length).toBe(1);
    expect((executable.match(/ADD CONSTRAINT/g) ?? []).length).toBe(1);
  });

  it("states the lock profile, the deploy order and the rollback in its header", () => {
    expect(sql).toMatch(/LOCK PROFILE/);
    expect(sql).toMatch(/DEPLOY ORDER \(L-184\)/);
    expect(sql).toMatch(/Rollback/);
  });

  it("matches the Prisma schema: `position Int?` on InvoiceItem, nothing else added to it", () => {
    const finance = readFileSync(join(SCHEMA_DIR, "finance.prisma"), "utf8");
    const model = finance.match(/model InvoiceItem \{[\s\S]*?\n\}/);
    expect(model).not.toBeNull();
    expect(model![0]).toMatch(/^\s*position\s+Int\?\s*$/m);
    expect(model![0]).not.toMatch(/position\s+Int\??\s+@default/);
  });
});
