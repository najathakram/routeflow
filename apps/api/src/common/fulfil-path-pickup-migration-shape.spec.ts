import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { FulfillPath } from "@prisma/client";

/**
 * SA-650 (counter sales, item C step 1): `FulfillPath` gains `PICKUP` in its OWN migration. The
 * migration file is READ at test time and pinned by shape: one transaction, a bounded lock_timeout,
 * one ADD VALUE, nothing else (a value added in a transaction cannot be used in it).
 */
const FOLDER = "20261004150000_fulfil_path_pickup";
const PREFIX = "20261004150000";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const MIGRATION = join(MIGRATIONS_DIR, FOLDER, "migration.sql");

function executableSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("fulfil-path PICKUP migration shape (SA-650)", () => {
  it("sorts after the sitting-B bundle and the two PC branch migrations, and owns its timestamp", () => {
    expect(FOLDER > "20260929220000_sitting_b_bundle").toBe(true);
    expect(FOLDER > "20261003120000").toBe(true);
    expect(FOLDER > "20261003120100").toBe(true);
    const sameStamp = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith(PREFIX));
    expect(sameStamp).toEqual([FOLDER]);
  });

  it("is exactly BEGIN; lock_timeout; ALTER TYPE ADD VALUE 'PICKUP'; COMMIT", () => {
    const sql = executableSql();
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    const stmts = sql
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(stmts).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = '5s'",
      `ALTER TYPE "FulfillPath" ADD VALUE 'PICKUP'`,
      "COMMIT",
    ]);
    // 'PICKUP' appears once (the ADD VALUE) and no table is touched
    expect((sql.match(/PICKUP/g) ?? []).length).toBe(1);
    expect(sql).not.toMatch(/\bTABLE\b/i);
  });

  it("the generated Prisma enum is ROUTE, SHIP, PICKUP in that order (ADD VALUE appends)", () => {
    expect(Object.values(FulfillPath)).toEqual(["ROUTE", "SHIP", "PICKUP"]);
  });
});
