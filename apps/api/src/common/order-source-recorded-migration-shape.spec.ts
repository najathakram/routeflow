import { execFileSync } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * PR #3418 MUST 5: `Order.sourceRecorded` replaces the clock cutoff of the F1(i) author rule. ONE additive column,
 * BOOLEAN NOT NULL DEFAULT false: a constant default, so Postgres 11+ adds it as a catalog change (no table rewrite,
 * no backfill). Every existing row reads false = UNKNOWN_LEGACY (judged on STAFF), which is exactly the intent; the
 * new code writes true at every create site. Pinned by shape: one transaction, the project's bounded lock_timeout,
 * the one ADD COLUMN, nothing else; and the Prisma model carries the same field.
 */
const FOLDER = "20261013000000_order_source_recorded";
const PREFIX = "20261013000000";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const MIGRATION = join(MIGRATIONS_DIR, FOLDER, "migration.sql");

function executableSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("order sourceRecorded migration shape (PR #3418 MUST 5)", () => {
  it("sorts after every folder that existed when it was written and owns its timestamp", () => {
    // 20261010090900 was the newest folder on this branch AND on origin/master when this one was added.
    expect(FOLDER > "20261010090900_b2230_unit_line_split_validate").toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith(PREFIX))).toEqual([FOLDER]);
  });

  it("is exactly BEGIN; lock_timeout; ADD COLUMN sourceRecorded BOOLEAN NOT NULL DEFAULT false; COMMIT", () => {
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
      `ALTER TABLE "Order" ADD COLUMN "sourceRecorded" BOOLEAN NOT NULL DEFAULT false`,
      "COMMIT",
    ]);
  });

  it("is additive only: no UPDATE / DELETE / DROP / backfill, no volatile default, no squawk-ignore", () => {
    const sql = executableSql();
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE|INSERT|RENAME|ALTER COLUMN)\b/i);
    expect(sql).not.toMatch(/DEFAULT\s+(now|gen_random|uuid|clock|random)/i);
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/squawk-ignore/);
  });

  it("the Prisma Order model carries the same field (sales.prisma)", () => {
    const schema = readFileSync(
      join(__dirname, "..", "..", "prisma", "schema", "sales.prisma"),
      "utf8",
    );
    const order = schema.slice(schema.indexOf("model Order {"));
    expect(order.slice(0, order.indexOf("\n}"))).toMatch(
      /^\s+sourceRecorded\s+Boolean\s+@default\(false\)/m,
    );
  });

  it("the schema folder still passes the split's structural check", () => {
    const repo = join(__dirname, "..", "..", "..", "..");
    expect(() =>
      execFileSync(
        process.execPath,
        [join(repo, "apps", "api", "scripts", "split-prisma-schema.mjs"), "--check"],
        { cwd: repo, stdio: "pipe" },
      ),
    ).not.toThrow();
  });
});
