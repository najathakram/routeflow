import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-1124 PR-0: `OrderReviewFlag` + `OrderReviewFlagKind` + `Order.offlineCreatedAt`, as one additive migration folder.
 *
 * No app code reads or writes the new table or column in this PR, but the generated Prisma client SELECTS
 * `Order.offlineCreatedAt` on every order read, so merging before the migration has run in production fails those
 * reads with P2022: backup -> prod-migrate.mjs -> schema-drift.mjs exit 0 -> merge (L-184; nothing auto-migrates on
 * deploy). `tenantId` is NOT NULL from day one, and two raw-SQL CHECKs pin the resolution pair and length.
 */
const FOLDER = "20261110000000_order_review_flags_offline";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const SCHEMA_DIR = join(__dirname, "..", "..", "prisma", "schema");

const KINDS = [
  "PRICE_CHANGED_OFFLINE",
  "RESTRICTED",
  "LICENSE_REQUIRED",
  "CREDIT_BLOCKED",
  "OPEN_ORDER_EXISTS",
  "BACKORDERED_OFFLINE",
];

const sql = readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8");
const executable = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("SA-1124 PR-0 migration folder", () => {
  it("sorts after the newest migrations and owns its timestamp", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    expect(FOLDER > "20261107000000_tenant_ai_monthly_cap").toBe(true);
    expect(all.filter((n) => n.startsWith("20261110000000"))).toEqual([FOLDER]);
  });

  it("is one bounded transaction", () => {
    expect((executable.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((executable.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(executable).toContain("SET LOCAL lock_timeout = '5s'");
  });

  it("is additive: nothing dropped, rewritten, backfilled or defaulted on an existing table", () => {
    expect(executable).not.toMatch(
      /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|\bRENAME\b|ADD VALUE/im,
    );
    // the only statement on "Order" is the one nullable column, with no default
    expect(squash(executable)).toContain(
      `ALTER TABLE "Order" ADD COLUMN "offlineCreatedAt" TIMESTAMP(3);`,
    );
    expect((executable.match(/ALTER TABLE "Order" /g) ?? []).length).toBe(1);
  });

  it("creates the enum with exactly the six kinds, in order", () => {
    const m = squash(executable).match(/CREATE TYPE "OrderReviewFlagKind" AS ENUM \(([^)]*)\);/);
    expect(m).not.toBeNull();
    const values = m![1].split(",").map((v) => v.trim().replace(/'/g, ""));
    expect(values).toEqual(KINDS);
  });

  it("creates the table with tenantId NOT NULL, a NOT NULL kind and detail, and nullable resolution columns", () => {
    const table = squash(executable).match(/CREATE TABLE "OrderReviewFlag" \((.*?)\);/);
    expect(table).not.toBeNull();
    const body = table![1];
    expect(body).toContain('"tenantId" TEXT NOT NULL');
    expect(body).toContain('"orderId" TEXT NOT NULL');
    expect(body).toContain('"kind" "OrderReviewFlagKind" NOT NULL');
    expect(body).toContain('"detail" JSONB NOT NULL');
    expect(body).toMatch(/"orderItemId" TEXT,/);
    expect(body).toMatch(/"resolvedAt" TIMESTAMP\(3\),/);
    expect(body).toMatch(/"resolvedById" TEXT,/);
    expect(body).toMatch(/"resolution" TEXT,/);
  });

  it("carries the two CHECKs, in the table, valid from the start (the table is empty)", () => {
    const flat = squash(executable);
    expect(flat).toContain(
      `CONSTRAINT "OrderReviewFlag_resolution_pair" CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL))`,
    );
    expect(flat).toContain(
      `CONSTRAINT "OrderReviewFlag_resolution_len" CHECK ("resolution" IS NULL OR char_length("resolution") BETWEEN 3 AND 500)`,
    );
    expect(executable).not.toMatch(/NOT VALID/);
  });

  it("adds the four foreign keys with the ruled delete actions, and both indexes", () => {
    const flat = squash(executable);
    const fk = (col: string, table: string, action: string) =>
      expect(flat).toContain(
        `ADD CONSTRAINT "OrderReviewFlag_${col}_fkey" FOREIGN KEY ("${col}") REFERENCES "${table}"("id") ON DELETE ${action} ON UPDATE CASCADE;`,
      );
    fk("tenantId", "Tenant", "RESTRICT");
    fk("orderId", "Order", "CASCADE");
    fk("orderItemId", "OrderItem", "SET NULL");
    fk("resolvedById", "User", "SET NULL");
    expect(flat).toContain(
      `CREATE INDEX "OrderReviewFlag_tenantId_orderId_idx" ON "OrderReviewFlag"("tenantId", "orderId");`,
    );
    expect(flat).toContain(
      `CREATE INDEX "OrderReviewFlag_tenantId_kind_resolvedAt_idx" ON "OrderReviewFlag"("tenantId", "kind", "resolvedAt");`,
    );
  });

  it("needs no squawk-ignore: the table is new and the gate keeps only the destructive rules", () => {
    expect(sql).not.toMatch(/squawk-ignore/);
  });

  it("states the lock profile, the true deploy order and the rollback in its header", () => {
    expect(sql).toMatch(/LOCK PROFILE/);
    expect(sql).toMatch(/DEPLOY ORDER \(L-184\)/);
    // the header must not call a merge-first order safe: the client selects the new Order column (P2022 until migrated)
    expect(sql).toMatch(/NOT safe/);
    expect(sql).toMatch(/P2022/);
    expect(sql).toMatch(/fresh backup, `prod-migrate\.mjs`/);
    expect(sql).toMatch(/`schema-drift\.mjs` exit 0/);
    expect(sql).toMatch(/Rollback/);
  });

  it("matches the Prisma schema: the enum, the model, the column and the back-relations", () => {
    const sales = readFileSync(join(SCHEMA_DIR, "sales.prisma"), "utf8");
    const enumBlock = sales.match(/enum OrderReviewFlagKind \{([\s\S]*?)\n\}/);
    expect(enumBlock).not.toBeNull();
    expect(
      enumBlock![1]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//")),
    ).toEqual(KINDS);

    const model = sales.match(/model OrderReviewFlag \{[\s\S]*?\n\}/);
    expect(model).not.toBeNull();
    expect(model![0]).toMatch(/^\s*tenantId\s+String\s*$/m);
    expect(model![0]).toMatch(/onDelete: Cascade/);
    expect((model![0].match(/onDelete: SetNull/g) ?? []).length).toBe(2);
    expect(model![0]).toMatch(/@@index\(\[tenantId, orderId\]\)/);
    expect(model![0]).toMatch(/@@index\(\[tenantId, kind, resolvedAt\]\)/);

    const order = sales.match(/model Order \{[\s\S]*?\n\}/);
    expect(order![0]).toMatch(/^\s*offlineCreatedAt\s+DateTime\?\s*$/m);
    expect(order![0]).toMatch(/^\s*reviewFlags\s+OrderReviewFlag\[\]\s*$/m);
    const item = sales.match(/model OrderItem \{[\s\S]*?\n\}/);
    expect(item![0]).toMatch(/^\s*reviewFlags\s+OrderReviewFlag\[\]\s*$/m);
  });
});
