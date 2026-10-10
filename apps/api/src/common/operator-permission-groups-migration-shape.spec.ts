import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { OPERATOR_PERMISSION_GROUP_VALUES } from "@routeflow/types";

/**
 * Per-operator feature groups: one enum and two additive `User` columns, both NOT NULL with a CONSTANT
 * default (metadata-only on PG >= 11: no rewrite, no backfill; every existing row reads "all groups on",
 * version 0). Pinned by shape: one transaction, a bounded lock_timeout, nothing destructive, and the SQL
 * enum, the Prisma enum and the shared client mirror all list the same values in the same order.
 */
const FOLDER = "20261009120000_operator_permission_groups";
const PREFIX = "20261009120000";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const MIGRATION = join(MIGRATIONS_DIR, FOLDER, "migration.sql");
const TENANCY_SCHEMA = join(__dirname, "..", "..", "prisma", "schema", "tenancy.prisma");

function executableSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const statements = () =>
  executableSql()
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

describe("operator permission groups migration shape", () => {
  it("sorts after the previous newest migration and owns its timestamp", () => {
    expect(FOLDER > "20261007120000_rf_invoice_manual_lifecycle").toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith(PREFIX))).toEqual([FOLDER]);
  });

  it("is exactly BEGIN; lock_timeout; CREATE TYPE; ALTER TABLE User (2 columns); COMMIT", () => {
    const sql = executableSql();
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    const stmts = statements();
    expect(stmts).toHaveLength(5);
    expect(stmts[0]).toBe("BEGIN");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(stmts[2]).toMatch(/^CREATE TYPE "OperatorPermissionGroup" AS ENUM \(/);
    expect(stmts[3]).toBe(
      `ALTER TABLE "User" ADD COLUMN "deniedPermissionGroups" "OperatorPermissionGroup"[] NOT NULL DEFAULT '{}', ` +
        `ADD COLUMN "permissionsVersion" INTEGER NOT NULL DEFAULT 0`,
    );
    expect(stmts[4]).toBe("COMMIT");
  });

  it("is additive: nothing dropped, rewritten or backfilled", () => {
    expect(executableSql()).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|CREATE INDEX|\bRENAME\b/im,
    );
  });

  it("the SQL enum lists the shared mirror's values, in order", () => {
    const create = statements()[2];
    const listed = [...create.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...OPERATOR_PERMISSION_GROUP_VALUES]);
  });

  it("the Prisma schema declares the same enum and columns, in the tenancy file", () => {
    const schema = readFileSync(TENANCY_SCHEMA, "utf8");
    const enumBody = schema.slice(schema.indexOf("enum OperatorPermissionGroup {"));
    const values = enumBody
      .slice(enumBody.indexOf("{") + 1, enumBody.indexOf("}"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));
    expect(values).toEqual([...OPERATOR_PERMISSION_GROUP_VALUES]);

    const model = schema.slice(schema.indexOf("model User {"));
    const userBody = model.slice(0, model.indexOf("\n}"));
    expect(userBody).toMatch(
      /^\s+deniedPermissionGroups\s+OperatorPermissionGroup\[\]\s+@default\(\[\]\)/m,
    );
    expect(userBody).toMatch(/^\s+permissionsVersion\s+Int\s+@default\(0\)/m);
  });
});
