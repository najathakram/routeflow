import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * #2717 M3 (SA-572, SA-579, SA-582): the migration file is READ at test time (L-206) and pinned by
 * shape: additive only, one transaction, bounded lock waits, no FK on recipeId (I11), no CHECK (I12).
 */
const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20260929180000_2717_m3_documents",
  "migration.sql",
);

function executableSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("documents migration shape (#2717 M3)", () => {
  const sql = executableSql();

  it("creates one enum and two tables, and adds six nullable columns", () => {
    expect((sql.match(/^CREATE TYPE /gim) ?? []).length).toBe(1);
    expect((sql.match(/^CREATE TABLE /gim) ?? []).length).toBe(2);
    expect((sql.match(/ADD COLUMN/gi) ?? []).length).toBe(6);
    expect(sql).toMatch(/CREATE TYPE "CompositionMode" AS ENUM \('SINGLE', 'FIXED', 'FLEX'\)/);
  });

  it("is additive: no CHECK, UPDATE, DELETE, ALTER COLUMN, DROP or partial unique index", () => {
    expect(sql).not.toMatch(/CHECK\s*\(/i);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^;]*\bWHERE\b/i);
  });

  // SA-579 S1/S2 (SA-590): the component qty is a whole number of pieces, and the invoice component
  // has NO link back to the order component.
  it("component qty is INTEGER on both tables (SA-579 S1)", () => {
    for (const table of ["OrderItemComponent", "InvoiceItemComponent"]) {
      const block =
        sql.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
      expect(block).toMatch(/"qty" INTEGER NOT NULL/);
      expect(block).not.toMatch(/"qty" DECIMAL/i);
    }
  });

  it('has no "orderItemComponentId" column, index or FK anywhere (SA-579 S2)', () => {
    expect(sql).not.toMatch(/orderItemComponentId/);
  });

  it("gives recipeId no foreign key (I11: documents never JOIN Recipe)", () => {
    expect(sql).not.toMatch(/REFERENCES "Recipe"/);
  });

  it("has exactly one BEGIN and one COMMIT", () => {
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
  });

  // SA-575: a hand-written M2 migration missed its CREATE TYPE. Every enum in the schema folder must
  // be created by SOME migration, so a forgotten CREATE TYPE fails here, not on a fresh database.
  it("every enum in the schema folder has a CREATE TYPE in some migration", () => {
    const schemaDir = join(__dirname, "..", "..", "prisma", "schema");
    const enums = readdirSync(schemaDir)
      .filter((f) => f.endsWith(".prisma"))
      .flatMap((f) =>
        [...readFileSync(join(schemaDir, f), "utf8").matchAll(/^enum\s+(\w+)\s*\{/gm)].map(
          (m) => m[1],
        ),
      );
    const migDir = join(__dirname, "..", "..", "prisma", "migrations");
    const created = new Set(
      readdirSync(migDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((d) =>
          [
            ...readFileSync(join(migDir, d.name, "migration.sql"), "utf8").matchAll(
              /CREATE TYPE "(\w+)"/g,
            ),
          ].map((m) => m[1]),
        ),
    );
    expect(enums.length).toBeGreaterThan(0);
    expect(enums.filter((e) => !created.has(e))).toEqual([]);
  });

  it("runs in one transaction: BEGIN, SET LOCAL lock_timeout, the DDL, COMMIT", () => {
    const stmts = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => `${s};`);
    expect(stmts[0]).toBe("BEGIN;");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s';");
    expect(stmts[stmts.length - 1]).toBe("COMMIT;");
  });
});
