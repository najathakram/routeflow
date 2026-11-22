import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-1207 S1: three nullable columns on "ProductAlias" plus one CHECK, as one additive migration folder. Nothing reads or
 * writes them until S2a. Pins the SQL text, so a later edit of the applied file (or a fourth column) fails here.
 */
const FOLDER = "20261122000000_product_alias_pack_memory";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const sql = readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8");
const executable = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("SA-1207 S1 migration folder", () => {
  it("sorts after the newest earlier migration and owns its timestamp", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    expect(FOLDER > "20261121000100_tenant_plan_core_all_in").toBe(true);
    expect(all.filter((n) => n.startsWith("20261122000000"))).toEqual([FOLDER]);
  });

  it("is one bounded transaction", () => {
    expect((executable.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((executable.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(executable).toContain("SET LOCAL lock_timeout = '5s'");
  });

  it("adds exactly three nullable columns, with no default, to ProductAlias only", () => {
    expect(squash(executable)).toContain(
      `ALTER TABLE "ProductAlias" ADD COLUMN "packSize" INTEGER, ADD COLUMN "splitFamilyId" TEXT, ADD COLUMN "splitRecipe" JSONB;`,
    );
    expect((executable.match(/ALTER TABLE/g) ?? []).length).toBe(3);
    expect(executable).not.toMatch(/\bNOT NULL\b|\bDEFAULT\b/i);
  });

  it("adds the packSize CHECK as NOT VALID and validates it afterwards", () => {
    const flat = squash(executable);
    const add = flat.indexOf(
      `ADD CONSTRAINT "ProductAlias_packSize_positive" CHECK ("packSize" IS NULL OR "packSize" > 0) NOT VALID;`,
    );
    const validate = flat.indexOf(
      `ALTER TABLE "ProductAlias" VALIDATE CONSTRAINT "ProductAlias_packSize_positive";`,
    );
    expect(add).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(add);
  });

  it("is additive: nothing dropped, rewritten, backfilled or indexed", () => {
    expect(executable).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|\bRENAME\b|\bCREATE (UNIQUE )?INDEX\b|\bCREATE TABLE\b/im,
    );
  });
});
