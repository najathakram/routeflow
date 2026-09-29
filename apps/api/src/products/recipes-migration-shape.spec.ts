import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";

/**
 * #2717 M2 test 27 (SA-574, SA-575): the migration file is READ at test time (L-206) and pinned by
 * shape. It is additive only, bounded by lock_timeout, and carries the CREATE TYPE for every enum
 * the new models use — a missing CREATE TYPE deploys fine to review and dies at CREATE TABLE in
 * prod (the first cut of this migration had exactly that hole).
 */
const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20260929120000_2717_m2_recipes",
  "migration.sql",
);

/** Strip `--` comment lines first: the rollback header legitimately spells DROP/ALTER. */
function executableSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function count(re: RegExp, sql: string): number {
  return (sql.match(re) ?? []).length;
}

describe("recipes migration shape (#2717 M2, test 27)", () => {
  const sql = executableSql();

  it("creates exactly one enum, two tables and one column", () => {
    expect(count(/^CREATE TYPE /gim, sql)).toBe(1);
    expect(count(/^CREATE TABLE /gim, sql)).toBe(2);
    expect(count(/ADD COLUMN/gi, sql)).toBe(1);
  });

  it("has a CREATE TYPE for every enum the new models use", () => {
    const models = Prisma.dmmf.datamodel.models.filter((m) =>
      ["Recipe", "RecipeComponent"].includes(m.name),
    );
    expect(models).toHaveLength(2);
    const enumTypes = new Set<string>();
    for (const model of models) {
      for (const f of model.fields) if (f.kind === "enum") enumTypes.add(f.type);
    }
    expect([...enumTypes]).toContain("RecipeStatus");
    for (const name of enumTypes) {
      expect(sql).toMatch(new RegExp(`CREATE TYPE "${name}" AS ENUM`));
    }
  });

  it("creates the type before the table that uses it", () => {
    const typeAt = sql.indexOf('CREATE TYPE "RecipeStatus"');
    const tableAt = sql.indexOf('CREATE TABLE "Recipe"');
    expect(typeAt).toBeGreaterThanOrEqual(0);
    expect(tableAt).toBeGreaterThan(typeAt);
  });

  it("is additive: no partial unique index, CHECK, UPDATE, DELETE, ALTER COLUMN or DROP", () => {
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^;]*\bWHERE\b/i);
    expect(sql).not.toMatch(/CHECK\s*\(/i);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it("bounds lock waits with SET LOCAL lock_timeout", () => {
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '\d+s';/m);
  });

  it("runs in one transaction: BEGIN, then SET LOCAL, then the DDL, then COMMIT", () => {
    const stmts = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => `${s};`);
    expect(stmts[0]).toBe("BEGIN;");
    expect(stmts[stmts.length - 1]).toBe("COMMIT;");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s';");
    const firstCreate = stmts.findIndex((s) => /^CREATE\b/i.test(s));
    expect(firstCreate).toBeGreaterThan(1);
  });

  it("SA-583: exactly ONE BEGIN and ONE COMMIT (a second pair would end the first transaction early)", () => {
    expect(count(/^BEGIN;$/gm, sql)).toBe(1);
    expect(count(/^COMMIT;$/gm, sql)).toBe(1);
  });

  it("SA-583: the counter is discriminating: a doubled or missing BEGIN/COMMIT is seen", () => {
    expect(count(/^BEGIN;$/gm, "BEGIN;\nBEGIN;\nCOMMIT;")).toBe(2);
    expect(count(/^COMMIT;$/gm, "BEGIN;\nCOMMIT;\nCOMMIT;")).toBe(2);
    expect(count(/^COMMIT;$/gm, "BEGIN;\nSELECT 1;")).toBe(0);
  });
});
