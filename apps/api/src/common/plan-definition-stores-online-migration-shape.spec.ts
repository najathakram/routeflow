import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-1269 (P-40b): "PlanDefinition"."storesOnlineIncluded", one nullable INTEGER in one additive migration folder
 * (null = no cap). No default, no backfill, no reader or writer yet. Pins the SQL text.
 */
const FOLDER = "20261124000100_plan_definition_stores_online_included";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const sql = readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8");
const executable = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("SA-1269 P-40b migration folder", () => {
  it("sorts after the newest earlier migration and owns its timestamp", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    expect(FOLDER > "20261122000100_void_date").toBe(true);
    expect(all.filter((n) => n.startsWith("20261124000100"))).toEqual([FOLDER]);
  });

  it("is one bounded transaction", () => {
    expect((executable.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((executable.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(executable).toContain("SET LOCAL lock_timeout = '5s'");
  });

  it("adds exactly one nullable INTEGER column, no default", () => {
    expect(squash(executable)).toContain(
      `ALTER TABLE "PlanDefinition" ADD COLUMN "storesOnlineIncluded" INTEGER;`,
    );
    expect((executable.match(/ALTER TABLE/g) ?? []).length).toBe(1);
    expect(executable).not.toMatch(/\bNOT NULL\b|\bDEFAULT\b/i);
  });

  it("is additive: nothing dropped, rewritten, backfilled, constrained or indexed", () => {
    expect(executable).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|\bRENAME\b|\bCREATE (UNIQUE )?INDEX\b|\bCREATE TABLE\b|\bCONSTRAINT\b/im,
    );
  });
});
