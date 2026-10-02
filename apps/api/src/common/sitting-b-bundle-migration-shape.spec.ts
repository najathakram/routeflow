import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * SA-603 Sitting-B schema bundle: the migration file is READ at test time and pinned by shape.
 * Final DDL (SA-603a): `Product.portalVisible` + retired* columns, `ProductBarcode.code` DROP NOT NULL
 * + `retiredCode`, the two active-only Product NAME partial uniques (SA-603b, gated), and the `EmailDelivery` table (+ its 6-value enum).
 * SA-603c: `EmailDelivery.contentFingerprint` (nullable hash, never content) and the folded-in #1337 `PolicyValue` table (+ `PolicyScopeType` enum), no partial index on it. Metadata-only.
 * SA-603c also appends exactly three `NotificationEvent` values (STAFF_NEW_ORDER, BUYER_ORDER_EDITED, BUYER_ORDER_CANCELLED) via ADD VALUE inside the one wrap, never used in the same transaction.
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
    .map((s) => s.replace(/\s+/g, " ").trim())
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
    const idx = raw
      .map((l, n) => (!l.trim().startsWith("--") && /DROP NOT NULL/i.test(l) ? n : -1))
      .filter((n) => n >= 0);
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

  it("EmailDelivery has a nullable contentFingerprint TEXT column (SA-603c)", () => {
    const table = sql.match(/CREATE TABLE "EmailDelivery" \(([\s\S]*?)\n\);/);
    expect(table).not.toBeNull();
    const cols = table![1].replace(/\s+/g, " ");
    expect(cols).toMatch(/"contentFingerprint" TEXT(,|\s*$)/);
    expect(cols).not.toMatch(/"contentFingerprint" TEXT NOT NULL/);
  });

  it("creates the PolicyScopeType enum before its first use (SA-603c)", () => {
    const create = stmts.findIndex((s) =>
      /^CREATE TYPE "PolicyScopeType" AS ENUM \('TENANT', ?'CATEGORY', ?'CUSTOMER'\)$/.test(s),
    );
    expect(create).toBeGreaterThan(-1);
    const firstUse = stmts.findIndex((s, i) => i !== create && s.includes('"PolicyScopeType"'));
    expect(firstUse).toBeGreaterThan(create);
  });

  it("creates PolicyValue with its columns, two indexes and the tenant FK ON DELETE CASCADE (SA-603c)", () => {
    const table = sql.match(/CREATE TABLE "PolicyValue" \(([\s\S]*?)\n\);/);
    expect(table).not.toBeNull();
    const cols = table![1].replace(/\s+/g, " ");
    for (const col of [
      "id",
      "tenantId",
      "key",
      "scopeType",
      "scopeId",
      "value",
      "reason",
      "setById",
      "setByName",
      "createdAt",
      "supersededAt",
      "supersededById",
    ]) {
      expect(cols).toContain(`"${col}" `);
    }
    expect(cols).toMatch(/"value" JSONB NOT NULL/);
    const idx = stmts.filter((x) => /^CREATE (UNIQUE )?INDEX "PolicyValue_/.test(x));
    expect(idx).toHaveLength(2);
    expect(
      idx.some((x) =>
        x.startsWith('CREATE INDEX "PolicyValue_tenantId_key_scopeType_scopeId_supersededAt_idx"'),
      ),
    ).toBe(true);
    expect(idx.some((x) => x.startsWith('CREATE INDEX "PolicyValue_tenantId_idx"'))).toBe(true);
    for (const x of idx) expect(x).not.toMatch(/\bWHERE\b/i);
    expect(sql).toMatch(
      /ALTER TABLE "PolicyValue" ADD CONSTRAINT "PolicyValue_tenantId_fkey" FOREIGN KEY \("tenantId"\) REFERENCES "Tenant"\("id"\) ON DELETE CASCADE/,
    );
  });

  it("is otherwise additive only", () => {
    // the only DROPs: the one DROP NOT NULL and the two prod-only index drops (IF EXISTS, SA-603b)
    expect(
      sql.replace(/DROP NOT NULL/g, "").replace(/DROP INDEX IF EXISTS "[A-Za-z_]+"/g, ""),
    ).not.toMatch(/\bDROP\b/i);
    expect(sql.replace(/ON UPDATE CASCADE/g, "")).not.toMatch(/\bUPDATE\b/i);
    expect(sql.replace(/ON DELETE CASCADE/g, "")).not.toMatch(/\bDELETE\b/i);
    expect((sql.match(/ALTER COLUMN/gi) ?? []).length).toBe(1);
    expect(sql).not.toMatch(/SET NOT NULL/i);
    // partial indexes: exactly the two active-only name uniques (SA-603b), nothing else
    const partial = stmts.filter((x) => /^CREATE (UNIQUE )?INDEX/.test(x) && /\bWHERE\b/i.test(x));
    expect(partial).toHaveLength(2);
  });

  it("Product NAME uniqueness (SA-603b): drops the prod-only indexes IF EXISTS, then two active-only partial uniques", () => {
    const drops = stmts.filter((x) => x.startsWith("DROP INDEX"));
    expect(drops).toEqual([
      'DROP INDEX IF EXISTS "Product_tenantId_name_root_key"',
      'DROP INDEX IF EXISTS "Product_tenantId_parent_name_key"',
    ]);
    const root = stmts.find((x) =>
      x.startsWith('CREATE UNIQUE INDEX "Product_tenant_root_name_active_key"'),
    );
    const kid = stmts.find((x) =>
      x.startsWith('CREATE UNIQUE INDEX "Product_tenant_parent_name_active_key"'),
    );
    expect(root).toBe(
      'CREATE UNIQUE INDEX "Product_tenant_root_name_active_key" ON "Product"("tenantId", "name") WHERE "parentProductId" IS NULL AND "isActive"',
    );
    expect(kid).toBe(
      'CREATE UNIQUE INDEX "Product_tenant_parent_name_active_key" ON "Product"("tenantId", "parentProductId", "name") WHERE "parentProductId" IS NOT NULL AND "isActive"',
    );
    // drops and creates sit inside the one wrap, after the Product ADD COLUMNs
    const iDrop = stmts.indexOf(drops[0]);
    const iAdd = stmts.findIndex((x) => /^ALTER TABLE "Product" ADD COLUMN/.test(x));
    expect(iAdd).toBeGreaterThan(-1);
    expect(iDrop).toBeGreaterThan(iAdd);
    expect(stmts.indexOf(root!)).toBeGreaterThan(iDrop);
  });

  it("NotificationEvent: exactly three ADD VALUEs, each name only in its own line, inside the wrap (SA-603c)", () => {
    const adds = stmts.filter((x) => /^ALTER TYPE "NotificationEvent" ADD VALUE/.test(x));
    expect(adds).toHaveLength(3);
    const names = ["STAFF_NEW_ORDER", "BUYER_ORDER_EDITED", "BUYER_ORDER_CANCELLED"];
    names.forEach((name, i) => {
      expect(adds[i]).toMatch(
        new RegExp(`^ALTER TYPE "NotificationEvent" ADD VALUE (IF NOT EXISTS )?'${name}'$`),
      );
      // never used elsewhere in the executable SQL
      expect((sql.match(new RegExp(name, "g")) ?? []).length).toBe(1);
      const idx = stmts.indexOf(adds[i]);
      expect(idx).toBeGreaterThan(stmts.indexOf("BEGIN"));
      expect(idx).toBeLessThan(stmts.indexOf("COMMIT"));
    });
    expect(sql).not.toMatch(/STAFF_ORDER_STATUS_CHANGED/);
  });

  it("SA-603g C2: EXACTLY ONE migration folder creates PolicyValue / PolicyScopeType (#1337 must drop its own folder)", () => {
    const folders = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    const creators = (re: RegExp) =>
      folders.filter((n) =>
        re.test(readFileSync(join(MIGRATIONS_DIR, n, "migration.sql"), "utf8")),
      );
    expect(creators(/CREATE TABLE "PolicyValue"/)).toEqual([FOLDER]);
    expect(creators(/CREATE TYPE "PolicyScopeType"/)).toEqual([FOLDER]);
  });
});
