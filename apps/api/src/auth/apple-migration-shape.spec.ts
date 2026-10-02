import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2309 / SA-597: the Apple sign-in migration is READ at test time and pinned by shape. It is
 * wrapped in exactly one BEGIN/COMMIT so `SET LOCAL lock_timeout` is effective (outside a
 * transaction it is a no-op), and it sorts after the M1/M2 migrations.
 */
const FOLDER = "20260929200000_2309_apple_sign_in";
const MIGRATION = join(__dirname, "..", "..", "prisma", "migrations", FOLDER, "migration.sql");

function executableSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function count(re: RegExp, sql: string): number {
  return (sql.match(re) ?? []).length;
}

describe("apple sign-in migration shape (#2309, SA-597)", () => {
  const sql = executableSql();

  it("runs in one transaction: BEGIN, then SET LOCAL, then the DDL, then COMMIT", () => {
    const stmts = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => `${s};`);
    expect(stmts[0]).toBe("BEGIN;");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s';");
    expect(stmts[stmts.length - 1]).toBe("COMMIT;");
    expect(stmts.findIndex((s) => /^(ALTER|CREATE)\b/i.test(s))).toBeGreaterThan(1);
  });

  it("has exactly ONE BEGIN and ONE COMMIT (a second pair would end the first early)", () => {
    expect(count(/^BEGIN;$/gm, sql)).toBe(1);
    expect(count(/^COMMIT;$/gm, sql)).toBe(1);
    expect(count(/^BEGIN;$/gm, "BEGIN;\nBEGIN;\nCOMMIT;")).toBe(2);
    expect(count(/^COMMIT;$/gm, "BEGIN;\nSELECT 1;")).toBe(0);
  });

  it("is additive: nullable adds and unique indexes only", () => {
    expect(sql).not.toMatch(/\bDROP\b|^\s*(UPDATE|DELETE)\b|ALTER COLUMN/im);
    expect(count(/ADD COLUMN/gi, sql)).toBe(3);
    expect(count(/^CREATE UNIQUE INDEX /gim, sql)).toBe(2);
  });

  it("adds nullable columns only: no NOT NULL and no DEFAULT (a table rewrite / backfill)", () => {
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(/NOT NULL/i.test('ADD COLUMN "x" TEXT NOT NULL')).toBe(true);
    expect(/\bDEFAULT\b/i.test("ADD COLUMN \"x\" TEXT DEFAULT 'a'")).toBe(true);
  });

  it("sorts after the M1 migration (the handoff's newest folder)", () => {
    expect(FOLDER > "20260929190000").toBe(true);
  });
});
