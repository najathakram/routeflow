/**
 * #2230 / SA-388d on REAL Postgres: the NOT VALID CHECKs `OrderItem_unitLine_split_chk` and
 * `InvoiceItem_unitLine_split_chk` (migration 20260926180000_b2230_unit_line_split_check_not_valid)
 * refuse B718's all-empty split on a multi-piece unit line and nothing else.
 *
 *  - a part-Case delivery rebuild (5 pieces of a 12-Case: boxes 0 + pieces 5) is written   (SA-178)
 *  - an "Each" line (factor 1, boxes/pieces null, qty = count) is written
 *  - {Case, 12, qty 36, boxes 0, pieces 0} and {..., boxes null, pieces null} are refused   (23514)
 *
 * Raw Prisma inserts, so the DATABASE decides (the writer assertion is pinned in unit-line-split.spec.ts).
 * SAFETY: a throwaway `qa-b2230-<run>` tenant (`assertTestTenant`); afterAll deletes exactly this
 * tenant's rows, in FK order. Collected only by `jest.db.config.js`; run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/** The SQLSTATE behind a Prisma adapter error (23514 = check_violation). */
function sqlState(err: any): string | undefined {
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code
  );
}

describeDb("#2230 unit-line split CHECK — real Postgres (SA-388d)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b2230-${run}`, "unit-line-split-check.db.spec.ts");
  let tenantId = "";
  let orderId = "";
  let invoiceId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `B2230 ${slug}` } })).id;
    const user = await raw.user.create({
      data: {
        email: `b2230-${run}@example.test`,
        username: `b2230-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: { userId: user.id, businessName: "B2230", contactName: "B2230", tenantId },
    });
    orderId = (
      await raw.order.create({
        data: { customerId: customer.id, status: "PENDING", subtotal: "0", total: "0", tenantId },
      })
    ).id;
    invoiceId = (
      await raw.invoice.create({
        data: {
          invoiceNumber: `INV-B2230-${run}`,
          customerId: customer.id,
          orderId,
          status: "DRAFT",
          subtotal: "0",
          total: "0",
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await raw.invoiceItem.deleteMany({ where: { tenantId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.invoice.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    }
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  type Split = {
    unitLabel: string;
    unitsPerBox: number | null;
    qty: number;
    boxes: number | null;
    pieces: number | null;
  };
  const insertOrderLine = (s: Split) =>
    raw.orderItem.create({ data: { orderId, unitPrice: "40", tenantId, ...s } });
  const insertInvoiceLine = (s: Split) =>
    raw.invoiceItem.create({
      data: {
        invoiceId,
        description: "B2230 line",
        unitPrice: "40",
        subtotal: "0",
        tenantId,
        ...s,
      },
    });

  const ALLOWED: [string, Split][] = [
    [
      "a part-Case delivery rebuild: 5 pieces of a 12-Case (SA-178)",
      { unitLabel: "Case", unitsPerBox: 12, qty: 5, boxes: 0, pieces: 5 },
    ],
    ["3 whole Cases", { unitLabel: "Case", unitsPerBox: 12, qty: 36, boxes: 3, pieces: 0 }],
    [
      'an "Each" line (factor 1, no split)',
      { unitLabel: "Each", unitsPerBox: 1, qty: 4, boxes: null, pieces: null },
    ],
    [
      "a REMOVE_ITEM-zeroed unit line (qty 0, split nulled)",
      { unitLabel: "Case", unitsPerBox: 12, qty: 0, boxes: null, pieces: null },
    ],
  ];
  const REFUSED: [string, Split][] = [
    [
      "the all-empty split with zeros",
      { unitLabel: "Case", unitsPerBox: 12, qty: 36, boxes: 0, pieces: 0 },
    ],
    [
      "the all-empty split with nulls",
      { unitLabel: "Case", unitsPerBox: 12, qty: 36, boxes: null, pieces: null },
    ],
  ];

  it("the two constraints are installed (NOT VALID is fine: new writes are enforced)", async () => {
    const { rows } = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`,
      [["InvoiceItem_unitLine_split_chk", "OrderItem_unitLine_split_chk"]],
    );
    expect(rows.map((r) => r.conname)).toEqual([
      "InvoiceItem_unitLine_split_chk",
      "OrderItem_unitLine_split_chk",
    ]);
  });

  it.each(ALLOWED)("OrderItem accepts %s", async (_name, s) => {
    await expect(insertOrderLine(s)).resolves.toMatchObject({ unitLabel: s.unitLabel });
  });

  it.each(ALLOWED)("InvoiceItem accepts %s", async (_name, s) => {
    await expect(insertInvoiceLine(s)).resolves.toMatchObject({ unitLabel: s.unitLabel });
  });

  it.each(REFUSED)("OrderItem refuses %s (23514)", async (_name, s) => {
    const err = await insertOrderLine(s).then(
      () => undefined,
      (e) => e,
    );
    expect(sqlState(err)).toBe("23514");
    expect(String(err?.message ?? err)).toMatch(/OrderItem_unitLine_split_chk/);
  });

  it.each(REFUSED)("InvoiceItem refuses %s (23514)", async (_name, s) => {
    const err = await insertInvoiceLine(s).then(
      () => undefined,
      (e) => e,
    );
    expect(sqlState(err)).toBe("23514");
    expect(String(err?.message ?? err)).toMatch(/InvoiceItem_unitLine_split_chk/);
  });

  /**
   * NOT VALID leaves a pre-existing violator in place, but ANY later UPDATE of that row is checked, even
   * a no-op one. A legacy violator is planted by dropping the constraint, inserting, and re-adding it
   * from its OWN captured definition (pg_get_constraintdef) as NOT VALID, all in one transaction on
   * this isolated DB, so the schema is left exactly as the migration made it.
   */
  it.each([
    ["OrderItem", "OrderItem_unitLine_split_chk"],
    ["InvoiceItem", "InvoiceItem_unitLine_split_chk"],
  ])("%s: a no-op UPDATE of a legacy all-empty row is refused (23514)", async (table, con) => {
    const legacyId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
        [con],
      );
      const def: string = rows[0].def;
      expect(def).toMatch(/NOT VALID$/);
      await client.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${con}"`);
      if (table === "OrderItem")
        await client.query(
          `INSERT INTO "OrderItem" (id, "orderId", "unitPrice", "tenantId", "unitLabel", "unitsPerBox", qty, boxes, pieces, "updatedAt")
           VALUES ($1, $2, 40, $3, 'Case', 12, 36, NULL, NULL, now())`,
          [legacyId, orderId, tenantId],
        );
      else
        await client.query(
          `INSERT INTO "InvoiceItem" (id, "invoiceId", description, "unitPrice", subtotal, "tenantId", "unitLabel", "unitsPerBox", qty, boxes, pieces, "updatedAt")
           VALUES ($1, $2, 'B2230 legacy', 40, 0, $3, 'Case', 12, 36, NULL, NULL, now())`,
          [legacyId, invoiceId, tenantId],
        );
      await client.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${con}" ${def}`);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    // The re-added constraint is the migration's, still NOT VALID.
    const { rows: after } = await pool.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
      [con],
    );
    expect(after).toEqual([{ convalidated: false }]);

    const err = await pool.query(`UPDATE "${table}" SET qty = qty WHERE id = $1`, [legacyId]).then(
      () => undefined,
      (e) => e,
    );
    expect(err?.code).toBe("23514");
    expect(String(err?.message)).toContain(con);
  });
});
