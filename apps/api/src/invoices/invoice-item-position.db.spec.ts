/**
 * W-1187 PR-1 against a real database: after `prisma migrate deploy`, `InvoiceItem.position` is a nullable INTEGER with no
 * default, and its CHECK (position IS NULL OR position >= 0) exists and was added NOT VALID, so the migration never scanned
 * the table and every existing line stays NULL. The write rules the CHECK enforces are exercised through a throwaway
 * `qa-ipos-<run>` business (`assertTestTenant`).
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("InvoiceItem.position (W-1187 PR-1)", () => {
  let pool: Pool;
  let tenantId: string;
  let userId: string;
  let customerId: string;
  let invoiceId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    const slug = assertTestTenant(`qa-ipos-${RUN}`, "invoice-item-position.db.spec.ts");
    tenantId = randomUUID();
    await pool.query(
      `INSERT INTO "Tenant" ("id","slug","name","updatedAt") VALUES ($1,$2,$3, now())`,
      [tenantId, slug, `ipos ${slug}`],
    );
    userId = randomUUID();
    await pool.query(
      `INSERT INTO "User" ("id","tenantId","email","username","role","updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER', now())`,
      [userId, tenantId, `${slug}@example.test`, slug],
    );
    customerId = randomUUID();
    await pool.query(
      `INSERT INTO "Customer" ("id","tenantId","userId","businessName","contactName","updatedAt")
       VALUES ($1,$2,$3,'ipos','ipos', now())`,
      [customerId, tenantId, userId],
    );
    invoiceId = randomUUID();
    await pool.query(
      `INSERT INTO "Invoice" ("id","tenantId","customerId","invoiceNumber","subtotal","total","updatedAt")
       VALUES ($1,$2,$3,$4,0,0, now())`,
      [invoiceId, tenantId, customerId, `IPOS-${RUN}`],
    );
  });

  afterAll(async () => {
    const swallow = () => undefined;
    await pool.query(`DELETE FROM "InvoiceItem" WHERE "tenantId" = $1`, [tenantId]).catch(swallow);
    await pool.query(`DELETE FROM "Invoice" WHERE "tenantId" = $1`, [tenantId]).catch(swallow);
    await pool.query(`DELETE FROM "Customer" WHERE "tenantId" = $1`, [tenantId]).catch(swallow);
    await pool.query(`DELETE FROM "User" WHERE "tenantId" = $1`, [tenantId]).catch(swallow);
    await pool.query(`DELETE FROM "Tenant" WHERE id = $1`, [tenantId]).catch(swallow);
    await pool?.end();
  });

  const addLine = (position: number | null) =>
    pool.query(
      `INSERT INTO "InvoiceItem" ("id","invoiceId","tenantId","description","qty","unitPrice","subtotal","position","updatedAt")
       VALUES ($1,$2,$3,'line',1,0,0,$4, now())`,
      [randomUUID(), invoiceId, tenantId, position],
    );

  it("P-1: the column is a nullable INTEGER with no default", async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'InvoiceItem' AND column_name = 'position'`,
    );
    expect(r.rows).toEqual([{ data_type: "integer", is_nullable: "YES", column_default: null }]);
  });

  it("P-2: the CHECK exists and was added NOT VALID (no table scan, existing rows stay NULL)", async () => {
    const r = await pool.query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'InvoiceItem_position_nonneg_chk' AND conrelid = '"InvoiceItem"'::regclass`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].convalidated).toBe(false);
    expect(r.rows[0].def).toMatch(/position IS NULL\) OR \("position" >= 0\)|position" IS NULL/);
  });

  it("P-3: NULL and 0 are accepted, a negative position is refused, a line written without one is NULL", async () => {
    await addLine(null);
    await addLine(0);
    await expect(addLine(-1)).rejects.toThrow(/InvoiceItem_position_nonneg_chk/);
    await pool.query(
      `INSERT INTO "InvoiceItem" ("id","invoiceId","tenantId","description","qty","unitPrice","subtotal","updatedAt")
       VALUES ($1,$2,$3,'legacy writer',1,0,0, now())`,
      [randomUUID(), invoiceId, tenantId],
    );
    const r = await pool.query(
      `SELECT description, "position" FROM "InvoiceItem" WHERE "invoiceId" = $1 ORDER BY description`,
      [invoiceId],
    );
    expect(r.rows.find((x) => x.description === "legacy writer")!.position).toBeNull();
    expect(r.rows.filter((x) => x.position !== null).map((x) => x.position)).toEqual([0]);
  });
});
