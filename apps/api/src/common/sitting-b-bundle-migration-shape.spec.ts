import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-603 Sitting-B schema bundle: the migration file is READ at test time and pinned by shape.
 * Final DDL (SA-603a): `Product.portalVisible` + retired* columns, `ProductBarcode.code` DROP NOT NULL
 * + `retiredCode`, and the `EmailDelivery` table (+ its 6-value enum). Metadata-only.
 */
const FOLDER = "20260929220000_sitting_b_bundle";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const MIGRATION = join(MIGRATIONS_DIR, FOLDER, "migration.sql");

function executableSql(): string {
  return readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("sitting-B bundle migration shape (SA-603)", () => {
  it("sorts after the prior migrations and every other folder", () => {
    expect(FOLDER > "20260929200000_2309_apple_sign_in").toBe(true);
    expect(FOLDER > "20260929210000_1337_policy_value").toBe(true);
    const others = readdirSync(MIGRATIONS_DIR).filter(
      (n) => n !== FOLDER && n !== "migration_lock.toml",
    );
    for (const name of others) expect(FOLDER > name).toBe(true);
  });

  const sql = executableSql();
  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  it("is one transaction with a bounded lock_timeout right after BEGIN", () => {
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(stmts[0]).toBe("BEGIN");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it("creates the enum before its first use", () => {
    const create = sql.indexOf('CREATE TYPE "EmailDeliveryStatus"');
    expect(create).toBeGreaterThan(-1);
    const firstUse = sql.indexOf('"EmailDeliveryStatus"', create + 1);
    expect(firstUse).toBeGreaterThan(create);
    expect(sql.indexOf('"EmailDeliveryStatus"')).toBe(create + "CREATE TYPE ".length);
  });

  it("creates the enum with exactly the six values in order", () => {
    expect(sql).toMatch(
      /CREATE TYPE "EmailDeliveryStatus" AS ENUM \('QUEUED',\s*'SENT',\s*'FAILED',\s*'BOUNCED',\s*'WOULD_SEND',\s*'OPTED_OUT'\)/,
    );
  });

  it("adds Product.portalVisible and the three nullable retired* TEXT columns", () => {
    const stmt = stmts.find((s) => /^ALTER TABLE "Product"\s/.test(s));
    expect(stmt).toBeDefined();
    expect(stmt).toContain('ADD COLUMN "portalVisible" BOOLEAN NOT NULL DEFAULT true');
    for (const col of ["retiredSku", "retiredBarcode", "retiredUnitSku"]) {
      expect(stmt).toMatch(new RegExp(`ADD COLUMN "${col}" TEXT(,|$)`));
    }
  });

  it("ProductBarcode: exactly one DROP NOT NULL on code and ADD COLUMN retiredCode TEXT", () => {
    const stmt = stmts.find((s) => /^ALTER TABLE "ProductBarcode"\s/.test(s));
    expect(stmt).toBeDefined();
    expect((stmt!.match(/ALTER COLUMN/g) ?? []).length).toBe(1);
    expect(stmt).toContain('ALTER COLUMN "code" DROP NOT NULL');
    expect(stmt).toMatch(/ADD COLUMN "retiredCode" TEXT(,|$)/);
  });

  it("has exactly one DROP NOT NULL overall, preceded by a -- reason: line", () => {
    const raw = readFileSync(MIGRATION, "utf8").split("\n");
    const idx = raw.map((l, n) => (/DROP NOT NULL/i.test(l) ? n : -1)).filter((n) => n >= 0);
    expect(idx.length).toBe(1);
    expect(raw.slice(0, idx[0]).some((l) => /^--\s*reason:/i.test(l.trim()))).toBe(true);
    expect((sql.match(/DROP NOT NULL/gi) ?? []).length).toBe(1);
  });

  it("creates EmailDelivery with its 3 indexes and the tenant FK ON DELETE CASCADE", () => {
    expect(sql).toMatch(/CREATE TABLE "EmailDelivery"/);
    expect((sql.match(/CREATE INDEX "EmailDelivery_/g) ?? []).length).toBe(3);
    expect(sql).toMatch(
      /ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_tenantId_fkey" FOREIGN KEY \("tenantId"\) REFERENCES "Tenant"\("id"\) ON DELETE CASCADE/,
    );
  });

  it("has no subject/body column (PII minimal)", () => {
    const table = sql.match(/CREATE TABLE "EmailDelivery" \(([\s\S]*?)\n\);/);
    expect(table).not.toBeNull();
    expect(table![1]).not.toMatch(/"subject"|"body"/i);
  });

  it("is otherwise additive only", () => {
    expect(sql.replace(/DROP NOT NULL/g, "")).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect((sql.match(/ALTER COLUMN/gi) ?? []).length).toBe(1);
    expect(sql).not.toMatch(/SET NOT NULL/i);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX[^;]*\bWHERE\b/i);
  });
});
