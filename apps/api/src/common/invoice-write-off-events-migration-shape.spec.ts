import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { INVOICE_WRITE_OFF_KIND_VALUES, OPERATOR_PERMISSION_GROUP_VALUES } from "@routeflow/types";

/**
 * SA-1050 PR-0: the bad-debt write-off ledger and the BAD_DEBT permission group, as two additive migration folders.
 *
 * Folder 1 is schema only: the kind enum, the event table (CHECKs inline, two FKs, two indexes), one nullable column
 * on Invoice and the new BAD_DEBT enum value. Folder 2 is the first USE of that value, so it must be a later
 * transaction: a value added in a transaction cannot be used until it commits ("unsafe use of new value"). It sets
 * the column default to `{BAD_DEBT}` and appends the group to every OPERATOR's deny list.
 *
 * Nothing in the app reads or writes any of this yet; merges only inside sitting #5.
 */
const SCHEMA_FOLDER = "20261028100000_invoice_write_off_events_and_bad_debt_group";
const DATA_FOLDER = "20261028100100_bad_debt_default_denied";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const SCHEMA_DIR = join(__dirname, "..", "..", "prisma", "schema");

const sqlOf = (folder: string) =>
  readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");
const executable = (folder: string) =>
  sqlOf(folder)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("SA-1050 PR-0 migration folders", () => {
  it("sort after the previous newest migration and own their timestamps", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((n) => n !== "migration_lock.toml");
    expect(SCHEMA_FOLDER > "20261026090000_stock_count_seed_state").toBe(true);
    expect(DATA_FOLDER > SCHEMA_FOLDER).toBe(true);
    expect(all.filter((n) => n.startsWith("20261028100000"))).toEqual([SCHEMA_FOLDER]);
    expect(all.filter((n) => n.startsWith("20261028100100"))).toEqual([DATA_FOLDER]);
  });

  describe("folder 1: schema", () => {
    const sql = () => executable(SCHEMA_FOLDER);

    it("is one bounded transaction", () => {
      expect((sql().match(/^BEGIN;/gm) ?? []).length).toBe(1);
      expect((sql().match(/^COMMIT;/gm) ?? []).length).toBe(1);
      expect(sql()).toContain("SET LOCAL lock_timeout = '5s'");
    });

    it("is additive: nothing dropped, rewritten, backfilled or used", () => {
      expect(sql()).not.toMatch(
        /\bDROP\b|\bTRUNCATE\b|^\s*(UPDATE|DELETE|INSERT)\b|ALTER COLUMN|\bRENAME\b|SET DEFAULT/im,
      );
      // the new enum value is added here and must not be used here
      expect(sql()).not.toMatch(/'BAD_DEBT'::|ARRAY\['BAD_DEBT'\]/);
    });

    it("creates the kind enum with the shared mirror's values, in order", () => {
      const m = squash(sql()).match(/CREATE TYPE "InvoiceWriteOffKind" AS ENUM \(([^)]*)\)/);
      expect(m).not.toBeNull();
      expect([...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1])).toEqual([
        ...INVOICE_WRITE_OFF_KIND_VALUES,
      ]);
    });

    it("adds BAD_DEBT as the last permission group", () => {
      expect(squash(sql())).toContain(`ALTER TYPE "OperatorPermissionGroup" ADD VALUE 'BAD_DEBT'`);
      expect(OPERATOR_PERMISSION_GROUP_VALUES[OPERATOR_PERMISSION_GROUP_VALUES.length - 1]).toBe(
        "BAD_DEBT",
      );
    });

    it("adds one nullable column to Invoice, with no default", () => {
      expect(squash(sql())).toContain(`ALTER TABLE "Invoice" ADD COLUMN "writtenOffById" TEXT;`);
    });

    it("creates the event table with the ruled columns", () => {
      const t = squash(sql());
      expect(t).toContain(`CREATE TABLE "InvoiceWriteOffEvent" (`);
      for (const col of [
        `"id" TEXT NOT NULL`,
        `"tenantId" TEXT NOT NULL`,
        `"invoiceId" TEXT NOT NULL`,
        `"kind" "InvoiceWriteOffKind" NOT NULL`,
        `"amount" DECIMAL(10,2) NOT NULL`,
        `"preTax" DECIMAL(10,2) NOT NULL`,
        `"at" TIMESTAMP(3),`,
        `"byId" TEXT,`,
        `"reason" TEXT NOT NULL`,
        `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
        `CONSTRAINT "InvoiceWriteOffEvent_pkey" PRIMARY KEY ("id")`,
      ]) {
        expect(t).toContain(col);
      }
    });

    it("carries the three ruled CHECKs", () => {
      const t = squash(sql());
      expect(t).toContain(
        `CHECK ((kind = 'WRITE_OFF' AND amount > 0 AND "preTax" >= 0 AND "preTax" <= amount) OR ` +
          `(kind = 'REINSTATE' AND amount < 0 AND "preTax" <= 0 AND "preTax" >= amount))`,
      );
      expect(t).toContain(`CHECK (at IS NOT NULL OR (kind = 'WRITE_OFF' AND "byId" IS NULL))`);
      expect(t).toContain(`CHECK (length(btrim(reason)) > 0)`);
    });

    it("has the two indexes and the two foreign keys, Restrict to Invoice and SetNull to User", () => {
      const t = squash(sql());
      expect(t).toContain(
        `CREATE INDEX "InvoiceWriteOffEvent_tenantId_at_idx" ON "InvoiceWriteOffEvent"("tenantId", "at")`,
      );
      expect(t).toContain(
        `CREATE INDEX "InvoiceWriteOffEvent_invoiceId_createdAt_idx" ON "InvoiceWriteOffEvent"("invoiceId", "createdAt")`,
      );
      expect(t).toContain(
        `ADD CONSTRAINT "InvoiceWriteOffEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
      );
      expect(t).toContain(
        `ADD CONSTRAINT "InvoiceWriteOffEvent_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
      );
    });
  });

  describe("folder 2: data", () => {
    const sql = () => squash(executable(DATA_FOLDER));

    it("is one bounded transaction", () => {
      expect((executable(DATA_FOLDER).match(/^BEGIN;/gm) ?? []).length).toBe(1);
      expect((executable(DATA_FOLDER).match(/^COMMIT;/gm) ?? []).length).toBe(1);
      expect(sql()).toContain("SET LOCAL lock_timeout = '5s'");
    });

    it("makes BAD_DEBT the default deny for a new account", () => {
      expect(sql()).toContain(
        `ALTER TABLE "User" ALTER COLUMN "deniedPermissionGroups" SET DEFAULT ARRAY['BAD_DEBT']::"OperatorPermissionGroup"[]`,
      );
    });

    it("appends BAD_DEBT to every OPERATOR's deny list, once, and bumps the version", () => {
      const t = sql();
      expect(t).toContain(`UPDATE "User" SET`);
      expect(t).toContain(
        `"deniedPermissionGroups" = array_append("deniedPermissionGroups", 'BAD_DEBT'::"OperatorPermissionGroup")`,
      );
      expect(t).toContain(`"permissionsVersion" = "permissionsVersion" + 1`);
      expect(t).toMatch(
        /WHERE "role" = 'OPERATOR' AND NOT \('BAD_DEBT'::"OperatorPermissionGroup" = ANY\("deniedPermissionGroups"\)\)/,
      );
    });

    it("drops, truncates and deletes nothing", () => {
      expect(executable(DATA_FOLDER)).not.toMatch(/\bDROP\b|\bTRUNCATE\b|^\s*DELETE\b/im);
    });
  });

  describe("the Prisma schema folder", () => {
    const finance = () => readFileSync(join(SCHEMA_DIR, "finance.prisma"), "utf8");
    const tenancy = () => readFileSync(join(SCHEMA_DIR, "tenancy.prisma"), "utf8");

    it("declares the kind enum and the event model in the finance file", () => {
      const f = finance();
      const enumBody = f.slice(f.indexOf("enum InvoiceWriteOffKind {"));
      const values = enumBody
        .slice(enumBody.indexOf("{") + 1, enumBody.indexOf("}"))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//"));
      expect(values).toEqual([...INVOICE_WRITE_OFF_KIND_VALUES]);
      expect(f).toContain("model InvoiceWriteOffEvent {");
      expect(f).toMatch(/^\s+writtenOffById\s+String\?/m);
    });

    it("lists BAD_DEBT last in the permission group enum and defaults the deny list to it", () => {
      const t = tenancy();
      const enumBody = t.slice(t.indexOf("enum OperatorPermissionGroup {"));
      const values = enumBody
        .slice(enumBody.indexOf("{") + 1, enumBody.indexOf("}"))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//"));
      expect(values).toEqual([...OPERATOR_PERMISSION_GROUP_VALUES]);
      expect(t).toMatch(
        /^\s+deniedPermissionGroups\s+OperatorPermissionGroup\[\]\s+@default\(\[BAD_DEBT\]\)/m,
      );
    });
  });
});
