/**
 * Units program S6 on REAL Postgres (migration 20261016120000_units_prices_v2_schema; SA-795 (b)):
 *  - "Product_packAuto_range_chk" refuses packAuto 32 and -1 and accepts 0..31          (23514)
 *  - "CustomerUnitPrice_price_positive_chk" refuses a price of 0 (and below)            (23514)
 *  - "ProductTierUnit_tier_range_chk" refuses tier 0 and 6, accepts 1..5                (23514)
 *  - UNIQUE(productId, tier) and UNIQUE(customerId, productId, unitRef)                 (23505 / P2002)
 *  - "<InvoiceItem|CreditNoteItem>_invoiceUnitFactor_positive_chk" (NOT VALID, still enforced on new rows)
 *  - deletes: Product cascades its tier units / customer unit prices and SET NULLs a PO or bill line's
 *    familyProductId; Customer cascades its unit prices
 *  - the orderUnitRef backfill: the migration's OWN Product ADD COLUMN statement, replayed on a temp
 *    table that already holds rows, leaves every pre-existing row at 'pack' / packAuto 0 (no UPDATE);
 *    and a legacy-shaped INSERT that names neither column reads 'pack' / 0.
 * Raw Prisma and pg writes, so the DATABASE decides. SAFETY: a throwaway `qa-s6units-<run>` tenant
 * (`assertTestTenant`); the replay runs on a session TEMP table (dropped at disconnect, never "Product");
 * afterAll deletes exactly this tenant's rows, in FK order. Collected only by `jest.db.config.js`; run via
 * `npm run local:test:db` (the DB lane; this machine has no Postgres).
 */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20261016120000_units_prices_v2_schema",
  "migration.sql",
);

/** The SQLSTATE behind a Prisma adapter error (23514 = check_violation, 23505 = unique_violation). */
function sqlState(err: any): string | undefined {
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code
  );
}
const rejectionOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e) => e,
  );

describeDb("units prices v2 schema — real Postgres (S6, SA-795 (b))", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-s6units-${run}`, "units-prices-v2-schema.db.spec.ts");
  let tenantId = "";
  let customerId = "";
  let productId = "";

  const product = (extra: Record<string, unknown> = {}) =>
    raw.product.create({
      data: {
        name: `S6 product ${randomUUID().slice(0, 6)}`,
        unit: "Box",
        pricePerUnit: "12",
        tenantId,
        ...extra,
      },
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `S6 ${slug}` } })).id;
    const user = await raw.user.create({
      data: { email: `s6-${run}@example.test`, username: `s6-${run}`, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: user.id, businessName: "S6", contactName: "S6", tenantId },
      })
    ).id;
    productId = (await product()).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await raw.customerUnitPrice.deleteMany({ where: { tenantId } });
      await raw.productTierUnit.deleteMany({ where: { tenantId } });
      await raw.invoiceItem.deleteMany({ where: { tenantId } });
      await raw.invoice.deleteMany({ where: { tenantId } });
      await raw.purchaseOrder.deleteMany({ where: { tenantId } }); // cascades its items
      await raw.vendorBill.deleteMany({ where: { tenantId } }); // cascades its items
      await raw.supplier.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    }
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("the five CHECKs are installed; the two item-table ones NOT VALID (enforced for new rows, no scan)", async () => {
    const { rows } = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`,
      [
        [
          "CreditNoteItem_invoiceUnitFactor_positive_chk",
          "CustomerUnitPrice_price_positive_chk",
          "InvoiceItem_invoiceUnitFactor_positive_chk",
          "ProductTierUnit_tier_range_chk",
          "Product_packAuto_range_chk",
        ],
      ],
    );
    expect(rows).toEqual([
      { conname: "CreditNoteItem_invoiceUnitFactor_positive_chk", convalidated: false },
      { conname: "CustomerUnitPrice_price_positive_chk", convalidated: true },
      { conname: "InvoiceItem_invoiceUnitFactor_positive_chk", convalidated: false },
      { conname: "ProductTierUnit_tier_range_chk", convalidated: true },
      { conname: "Product_packAuto_range_chk", convalidated: true },
    ]);
  });

  it("a product that names neither column reads packAuto 0 and orderUnitRef 'pack' (legacy writers)", async () => {
    const { rows } = await pool.query(
      `INSERT INTO "Product" ("id", "name", "unit", "pricePerUnit", "tenantId", "updatedAt")
       VALUES ($1, $2, 'Box', 10, $3, now()) RETURNING "packAuto", "orderUnitRef", "invoiceUnitRef"`,
      [randomUUID(), `S6 legacy ${run}`, tenantId],
    );
    expect(rows).toEqual([{ packAuto: 0, orderUnitRef: "pack", invoiceUnitRef: null }]);
  });

  it("the migration's own Product ADD COLUMN backfills PRE-EXISTING rows to 'pack' / 0 with no UPDATE", async () => {
    const sql = readFileSync(MIGRATION, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    const stmts = sql.split(";").map((s) => s.trim());
    const addCols = stmts.find((s) => /^ALTER TABLE "Product" ADD COLUMN/.test(s));
    const check = stmts.find((s) =>
      /^ALTER TABLE "Product" ADD CONSTRAINT "Product_packAuto/.test(s),
    );
    expect(addCols).toBeDefined();
    expect(check).toBeDefined();
    const onTemp = (s: string) =>
      s.replace('ALTER TABLE "Product"', 'ALTER TABLE pg_temp."s6_product_replay"');

    const client = await pool.connect();
    try {
      await client.query(`CREATE TEMP TABLE "s6_product_replay" ("id" TEXT PRIMARY KEY)`);
      await client.query(
        `INSERT INTO pg_temp."s6_product_replay" ("id") VALUES ('a'), ('b'), ('c')`,
      );
      await client.query(onTemp(addCols!));
      await client.query(onTemp(check!));
      const { rows } = await client.query(
        `SELECT "id", "packAuto", "orderUnitRef", "invoiceUnitRef" FROM pg_temp."s6_product_replay" ORDER BY "id"`,
      );
      expect(rows).toEqual(
        ["a", "b", "c"].map((id) => ({
          id,
          packAuto: 0,
          orderUnitRef: "pack",
          invoiceUnitRef: null,
        })),
      );
    } finally {
      await client.query(`DROP TABLE IF EXISTS pg_temp."s6_product_replay"`);
      client.release();
    }
  });

  it.each([0, 1, 16, 31])("Product accepts packAuto %i", async (packAuto) => {
    await expect(product({ packAuto })).resolves.toMatchObject({ packAuto });
  });

  it.each([32, -1])("Product refuses packAuto %i (23514)", async (packAuto) => {
    const err = await rejectionOf(product({ packAuto }));
    expect(sqlState(err)).toBe("23514");
    expect(String(err?.message ?? err)).toMatch(/Product_packAuto_range_chk/);
  });

  const unitPrice = (price: string, unitRef = "pack") =>
    raw.customerUnitPrice.create({ data: { tenantId, customerId, productId, unitRef, price } });

  it.each(["0", "0.00", "-1"])("CustomerUnitPrice refuses price %s (23514)", async (price) => {
    const err = await rejectionOf(unitPrice(price, `ref-${price}`));
    expect(sqlState(err)).toBe("23514");
    expect(String(err?.message ?? err)).toMatch(/CustomerUnitPrice_price_positive_chk/);
  });

  it("CustomerUnitPrice: one price per (customer, product, unitRef); another unit is a new row", async () => {
    await expect(unitPrice("9.00", "pack")).resolves.toMatchObject({ unitRef: "pack" });
    await expect(unitPrice("0.95", "base")).resolves.toMatchObject({ unitRef: "base" });
    const err = await rejectionOf(unitPrice("8.50", "pack"));
    expect(["P2002", "23505"]).toContain(sqlState(err));
  });

  const tierUnit = (tier: number, orderUnitRef: string | null = "base") =>
    raw.productTierUnit.create({ data: { tenantId, productId, tier, orderUnitRef } });

  it.each([0, 6])("ProductTierUnit refuses tier %i (23514)", async (tier) => {
    const err = await rejectionOf(tierUnit(tier));
    expect(sqlState(err)).toBe("23514");
    expect(String(err?.message ?? err)).toMatch(/ProductTierUnit_tier_range_chk/);
  });

  it("ProductTierUnit accepts tiers 1..5 once each; a second row for one (product, tier) is refused", async () => {
    for (const tier of [1, 2, 3, 4, 5])
      await expect(tierUnit(tier)).resolves.toMatchObject({ tier });
    const err = await rejectionOf(tierUnit(2, "pack"));
    expect(["P2002", "23505"]).toContain(sqlState(err));
  });

  it("deleting the product cascades its tier units and customer unit prices", async () => {
    const p = await product();
    await raw.productTierUnit.create({ data: { tenantId, productId: p.id, tier: 3 } });
    await raw.customerUnitPrice.create({
      data: { tenantId, customerId, productId: p.id, unitRef: "pack", price: "5" },
    });
    await raw.product.delete({ where: { id: p.id } });
    expect(await raw.productTierUnit.count({ where: { productId: p.id } })).toBe(0);
    expect(await raw.customerUnitPrice.count({ where: { productId: p.id } })).toBe(0);
  });
  it("InvoiceItem refuses invoiceUnitFactor 0 and -1 (23514); NULL and 24 are written", async () => {
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-S6-${run}`,
        customerId,
        status: "DRAFT",
        subtotal: "0",
        total: "0",
        tenantId,
      },
    });
    const line = (invoiceUnitFactor: number | null) =>
      raw.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          description: "S6 line",
          qty: "3",
          unitPrice: "18.90",
          subtotal: "56.70",
          tenantId,
          invoiceUnitLabel: invoiceUnitFactor == null ? null : "Piece",
          invoiceUnitFactor,
        },
      });
    await expect(line(null)).resolves.toMatchObject({ invoiceUnitFactor: null });
    await expect(line(24)).resolves.toMatchObject({ invoiceUnitFactor: 24 });
    for (const bad of [0, -1]) {
      const err = await rejectionOf(line(bad));
      expect(sqlState(err)).toBe("23514");
      expect(String(err?.message ?? err)).toMatch(/InvoiceItem_invoiceUnitFactor_positive_chk/);
    }
  });

  it("deleting a FAMILY product SET NULLs familyProductId on its split PO and bill lines (lines kept)", async () => {
    const family = await product();
    const variant = await product();
    const supplier = await raw.supplier.create({ data: { name: `S6 supplier ${run}`, tenantId } });
    const po = await raw.purchaseOrder.create({
      data: { poNumber: `PO-S6-${run}`, supplierId: supplier.id, totalAmount: "50", tenantId },
    });
    const poLine = await raw.purchaseOrderItem.create({
      data: {
        poId: po.id,
        productId: variant.id,
        qtyOrdered: "4",
        unitCost: "12.5",
        totalCost: "50",
        unitLabel: "Case",
        familyProductId: family.id,
        familyGroupId: `grp-${run}`,
        tenantId,
      },
    });
    const bill = await raw.vendorBill.create({
      data: { billNumber: `BILL-S6-${run}`, totalOwed: "50", tenantId },
    });
    const billLine = await raw.vendorBillItem.create({
      data: {
        vendorBillId: bill.id,
        productId: variant.id,
        description: "S6 split line",
        qty: "4",
        unitCost: "12.5",
        unitLabel: "Case",
        familyProductId: family.id,
        familyGroupId: `grp-${run}`,
        tenantId,
      },
    });
    await raw.product.delete({ where: { id: family.id } });
    await expect(
      raw.purchaseOrderItem.findUnique({ where: { id: poLine.id } }),
    ).resolves.toMatchObject({ familyProductId: null, familyGroupId: `grp-${run}` });
    await expect(
      raw.vendorBillItem.findUnique({ where: { id: billLine.id } }),
    ).resolves.toMatchObject({ familyProductId: null, familyGroupId: `grp-${run}` });
  });

  it("deleting a customer cascades its unit prices", async () => {
    const user = await raw.user.create({
      data: {
        email: `s6b-${run}@example.test`,
        username: `s6b-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const other = await raw.customer.create({
      data: { userId: user.id, businessName: "S6 B", contactName: "S6 B", tenantId },
    });
    await raw.customerUnitPrice.create({
      data: { tenantId, customerId: other.id, productId, unitRef: "pack", price: "7" },
    });
    await raw.customer.delete({ where: { id: other.id } });
    expect(await raw.customerUnitPrice.count({ where: { customerId: other.id } })).toBe(0);
  });
});
