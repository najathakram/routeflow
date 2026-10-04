import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-655 (counter sales item C step 2): `Customer.isWalkIn` — ONE nullable column, additive, in its
 * OWN migration. Null reads as "not a walk-in" for every existing row, so no backfill and no table
 * rewrite. Pinned by shape: one transaction, a bounded lock_timeout, one ADD COLUMN, nothing else.
 */
const FOLDER = "20261004160000_customer_is_walk_in";
const PREFIX = "20261004160000";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const MIGRATION = join(MIGRATIONS_DIR, FOLDER, "migration.sql");

function executableSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("customer isWalkIn migration shape (SA-655)", () => {
  it("sorts after the PICKUP migration and owns its timestamp", () => {
    expect(FOLDER > "20261004150000_fulfil_path_pickup").toBe(true);
    const sameStamp = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith(PREFIX));
    expect(sameStamp).toEqual([FOLDER]);
  });

  it("is exactly BEGIN; lock_timeout; ALTER TABLE ADD COLUMN isWalkIn BOOLEAN; COMMIT", () => {
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
      `ALTER TABLE "Customer" ADD COLUMN "isWalkIn" BOOLEAN`,
      "COMMIT",
    ]);
    // nullable, no default, no NOT NULL: a metadata-only change on Postgres
    expect(sql).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it("the Prisma model carries the same nullable field", () => {
    const schema = readFileSync(
      join(__dirname, "..", "..", "prisma", "schema", "sales.prisma"),
      "utf8",
    );
    const model = schema.slice(schema.indexOf("model Customer {"));
    expect(model.slice(0, model.indexOf("\n}"))).toMatch(/^\s+isWalkIn\s+Boolean\?/m);
  });
});
