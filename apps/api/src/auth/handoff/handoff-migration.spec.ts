/**
 * #2653 (SA-597 / SA-582): shape pins for the AuthHandoffCode migration. Static: reads the SQL and
 * the migrations directory, no database.
 *  - ONE explicit BEGIN; ... COMMIT; wrap with `SET LOCAL lock_timeout = '5s'` right after BEGIN
 *    (the two FKs lock "User" and "BuyerAccount"; SET LOCAL only lasts inside the transaction).
 *  - CREATE TYPE "HandoffRealm" comes before the table that uses it.
 *  - The folder sorts AFTER the newest migration that was on master when it was written
 *    (M3 #2717, 20260929180000): Prisma applies migrations in folder-name order, so an earlier
 *    name would be applied out of order on a database that already ran the later ones. A floor,
 *    not "last forever": later migrations legitimately sort after it.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS = join(__dirname, "..", "..", "..", "prisma", "migrations");
const SUFFIX = "_2653_auth_handoff_code";
const FLOOR = "20260929180000_2717_m3_documents";

const folders = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const mine = folders.filter((f) => f.endsWith(SUFFIX));
const sql = mine.length ? readFileSync(join(MIGRATIONS, mine[0], "migration.sql"), "utf8") : "";
const statements = sql
  .replace(/--.*$/gm, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("AuthHandoffCode migration shape (#2653, SA-597)", () => {
  it("exists exactly once, with a timestamped folder name", () => {
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(/^\d{14}_2653_auth_handoff_code$/);
    expect(existsSync(join(MIGRATIONS, mine[0], "migration.sql"))).toBe(true);
  });

  it("sorts after the newest migration that was on master when it was written (M3)", () => {
    expect(mine[0]! > FLOOR).toBe(true);
  });

  it("has exactly one BEGIN and one COMMIT, wrapping every statement", () => {
    expect(statements.filter((s) => /^BEGIN$/i.test(s))).toHaveLength(1);
    expect(statements.filter((s) => /^COMMIT$/i.test(s))).toHaveLength(1);
    expect(statements[0]).toMatch(/^BEGIN$/i);
    expect(statements[statements.length - 1]).toMatch(/^COMMIT$/i);
  });

  it("sets a 5 s lock_timeout with SET LOCAL, straight after BEGIN", () => {
    expect(statements[1]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(statements.filter((s) => /^SET\b/i.test(s))).toHaveLength(1);
  });

  it("creates the enum before the table that uses it", () => {
    const type = statements.findIndex((s) => /^CREATE TYPE "HandoffRealm"/.test(s));
    const table = statements.findIndex((s) => /^CREATE TABLE "AuthHandoffCode"/.test(s));
    expect(type).toBeGreaterThan(0);
    expect(table).toBeGreaterThan(type);
  });

  it("still creates only what the schema declares (enum, table, indexes, two FKs)", () => {
    const body = statements.filter((s) => !/^(BEGIN|COMMIT|SET LOCAL)/i.test(s));
    expect(body.filter((s) => /^CREATE TYPE/.test(s))).toHaveLength(1);
    expect(body.filter((s) => /^CREATE TABLE/.test(s))).toHaveLength(1);
    expect(body.filter((s) => /^CREATE (UNIQUE )?INDEX/.test(s))).toHaveLength(3);
    expect(
      body.filter((s) => /^ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY/s.test(s)),
    ).toHaveLength(2);
    // Statement STARTS only: the FKs legitimately say ON DELETE CASCADE ON UPDATE CASCADE.
    expect(body.some((s) => /^(DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/i.test(s))).toBe(false);
  });
});
