import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Units program S6 (PLAN §1.2; SA-795 (b), (g), (h)): the ONE additive migration folder, read at test
 * time and pinned by shape. Additive only: new nullable columns, two NOT NULL columns WITH constant
 * defaults (metadata-only; the default IS the `orderUnitRef = 'pack'` backfill of every existing
 * product), two new tables, CHECKs and indexes. Never a DROP, RENAME, ALTER TYPE or row UPDATE.
 */
const FOLDER = "20261016120000_units_prices_v2_schema";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");

function executableSql(): string {
  return readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("units prices v2 migration shape (S6)", () => {
  it("is on disk and sorts after every folder it must follow (incl. the pending 20261014140000)", () => {
    const folders = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_/.test(f));
    expect(folders).toContain(FOLDER);
    expect(FOLDER > "20261014140000").toBe(true);
    // Every OTHER folder present at authoring time sorts before this one (ordering, not "newest forever").
    expect(FOLDER > "20261014130000_selling_restriction_revisions").toBe(true);
  });

  const sql = executableSql();
  const stmts = sql
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const alterOf = (table: string) => stmts.filter((s) => s.startsWith(`ALTER TABLE "${table}" `));

  it("is one transaction with a bounded lock_timeout right after BEGIN", () => {
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(stmts[0]).toBe("BEGIN");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(stmts[stmts.length - 1]).toBe("COMMIT");
  });

  it("is additive only: no DROP, RENAME, ALTER TYPE, ALTER COLUMN, UPDATE, DELETE or TRUNCATE", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TYPE\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("Product.packAuto is INTEGER NOT NULL DEFAULT 0 with a CHECK 0..31", () => {
    const product = alterOf("Product").join(";");
    expect(product).toMatch(/ADD COLUMN "packAuto" INTEGER NOT NULL DEFAULT 0\b/);
    expect(sql).toMatch(
      /ALTER TABLE "Product" ADD CONSTRAINT "Product_packAuto_range_chk" CHECK \("packAuto" BETWEEN 0 AND 31\)/,
    );
  });

  it("Product.priceRevision is INTEGER NOT NULL DEFAULT 0 (SA-796 R-1: metadata-only, every row reads 0)", () => {
    const product = alterOf("Product").join(";");
    expect(product).toMatch(/ADD COLUMN "priceRevision" INTEGER NOT NULL DEFAULT 0\b/);
  });

  it("Product.orderUnitRef is backfilled to 'pack' by its constant default (no row rewrite); invoiceUnitRef is nullable", () => {
    const product = alterOf("Product").join(";");
    expect(product).toMatch(/ADD COLUMN "orderUnitRef" TEXT NOT NULL DEFAULT 'pack'/);
    expect(product).toMatch(/ADD COLUMN "invoiceUnitRef" TEXT(,|;|$)/);
  });

  it("CustomerPrice gains two nullable unit refs", () => {
    const cp = alterOf("CustomerPrice").join(";");
    expect(cp).toMatch(/ADD COLUMN "orderUnitRef" TEXT(,|;|$)/);
    expect(cp).toMatch(/ADD COLUMN "invoiceUnitRef" TEXT(,|;|$)/);
  });

  it.each(["InvoiceItem", "CreditNoteItem"])(
    "%s gains the display-only invoice unit snapshot (nullable)",
    (table) => {
      const t = alterOf(table).join(";");
      expect(t).toMatch(/ADD COLUMN "invoiceUnitLabel" TEXT(,|;|$)/);
      expect(t).toMatch(/ADD COLUMN "invoiceUnitFactor" INTEGER(,|;|$)/);
      // NOT VALID: enforced for new rows, no scan of a large table (every existing value is NULL).
      expect(sql).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_invoiceUnitFactor_positive_chk" CHECK ("invoiceUnitFactor" IS NULL OR "invoiceUnitFactor" > 0) NOT VALID;`,
      );
    },
  );

  it.each(["PurchaseOrderItem", "VendorBillItem"])(
    "%s gains the family-split columns, a SetNull FK and a familyGroupId index",
    (table) => {
      const t = alterOf(table).join(";");
      for (const col of ["unitLabel", "familyProductId", "familyGroupId"])
        expect(t).toMatch(new RegExp(`ADD COLUMN "${col}" TEXT(,|;|$)`));
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_familyProductId_fkey" FOREIGN KEY \\("familyProductId"\\) REFERENCES "Product"\\("id"\\) ON DELETE SET NULL ON UPDATE CASCADE`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(`CREATE INDEX "${table}_familyGroupId_idx" ON "${table}"\\("familyGroupId"\\)`),
      );
      // Product hard delete SET NULLs this column: without the index each delete seq-scans the table.
      expect(sql).toMatch(
        new RegExp(
          `CREATE INDEX "${table}_familyProductId_idx" ON "${table}"\\("familyProductId"\\)`,
        ),
      );
    },
  );

  it("creates ProductTierUnit with tier CHECK 2..5 (SA-796 R-2) and UNIQUE(productId, tier)", () => {
    expect(sql).toMatch(/CREATE TABLE "ProductTierUnit" \(/);
    expect(sql).toMatch(
      /ALTER TABLE "ProductTierUnit" ADD CONSTRAINT "ProductTierUnit_tier_range_chk" CHECK \("tier" BETWEEN 2 AND 5\);/,
    );
    // R-2: tier 1 (Retail) is the product scope itself, not a ProductTierUnit row; the old comment is gone.
    expect(readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8")).not.toMatch(
      /Tier 1 = Retail customers/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "ProductTierUnit_productId_tier_key" ON "ProductTierUnit"\("productId", "tier"\)/,
    );
    expect(sql).toMatch(
      /"ProductTierUnit_productId_fkey" FOREIGN KEY \("productId"\) REFERENCES "Product"\("id"\) ON DELETE CASCADE/,
    );
  });

  it("creates CustomerUnitPrice with price > 0 and UNIQUE(customerId, productId, unitRef)", () => {
    expect(sql).toMatch(/CREATE TABLE "CustomerUnitPrice" \(/);
    expect(sql).toMatch(/"unitRef" TEXT NOT NULL/);
    expect(sql).toMatch(/"price" DECIMAL\(10,2\) NOT NULL/);
    expect(sql).toMatch(
      /ALTER TABLE "CustomerUnitPrice" ADD CONSTRAINT "CustomerUnitPrice_price_positive_chk" CHECK \("price" > 0\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "CustomerUnitPrice_customerId_productId_unitRef_key" ON "CustomerUnitPrice"\("customerId", "productId", "unitRef"\)/,
    );
    expect(sql).toMatch(
      /"CustomerUnitPrice_customerId_fkey" FOREIGN KEY \("customerId"\) REFERENCES "Customer"\("id"\) ON DELETE CASCADE/,
    );
  });

  // SA-796 R-3 (fold N5): a stored ref is 'pack' | 'base' | a ProductUnit id (uuid), never a view `label:` ref.
  // NULL passes on the nullable columns (a CHECK that evaluates to NULL is satisfied). VALIDATED (no NOT VALID,
  // SA-796 G5/G6): Product and CustomerPrice are small, so one scan each; the two new tables are empty.
  const REF_COLUMNS: Array<[string, string]> = [
    ["Product", "orderUnitRef"],
    ["Product", "invoiceUnitRef"],
    ["CustomerPrice", "orderUnitRef"],
    ["CustomerPrice", "invoiceUnitRef"],
    ["ProductTierUnit", "orderUnitRef"],
    ["ProductTierUnit", "invoiceUnitRef"],
    ["CustomerUnitPrice", "unitRef"],
  ];
  const UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

  it.each(REF_COLUMNS)("%s.%s carries the validated R-3 ref-format CHECK", (table, col) => {
    expect(sql).toContain(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${col}_ref_format_chk" CHECK ("${col}" IN ('pack','base') OR "${col}" ~ '${UUID_RE}');`,
    );
  });

  it("the R-3 ref CHECKs are exactly the seven columns, none NOT VALID", () => {
    const refChecks = stmts.filter((s) => /_ref_format_chk"/.test(s));
    expect(refChecks).toHaveLength(7);
    for (const s of refChecks) expect(s).not.toMatch(/NOT VALID/);
  });

  it("carries no squawk-ignore (every kept Squawk rule passes; excluded rules need no silencing)", () => {
    expect(readFileSync(join(MIGRATIONS_DIR, FOLDER, "migration.sql"), "utf8")).not.toMatch(
      /squawk-ignore/,
    );
  });
});
