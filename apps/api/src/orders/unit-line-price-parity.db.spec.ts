/**
 * H3 — DB lane: POST /orders/sell and POST /invoices store the SAME unit-line price for the same
 * typed input, read back from real Postgres columns. Tenant-3 customer, Case list $24 / tier-3 $20,
 * x3, the operator types $24 (the list price) with a reason: both rows must read back $24 and a
 * $72 line total (the order path used to bill the tier price, $60 SPECIAL, with no reason).
 *
 *  P1 typed list price + reason: OrderItem and InvoiceItem both read back $24 / $72; the order line
 *     is MANUAL with the reason and the acting user stamped
 *  P2 typed tier price: both read back $20 / $60; the order line is SPECIAL, no reason, no stamp
 *  P3 typed list price with NO reason on a special tier: the order builder refuses (400), nothing is
 *     written, while the manual invoice still stores the typed price (it has no reason column)
 *
 * Run via `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js. Test
 * tenant only (`qa-*`, enforced by assertTestTenant).
 */
import { randomUUID } from "crypto";
import { BadRequestException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { LadderUnit } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buildInvoiceUnitLine } from "../invoices/invoice-unit-line";
import { resolveLineUnits } from "../products/line-units";
import { buildUnitLine, categoryTaxForLine } from "./unit-line-build";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("H3 unit-line price parity — orders/sell vs invoices, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-h3parity-${run}`, "unit-line-price-parity.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let orderId = "";
  let invoiceId = "";
  let productId = "";

  const ladderRows = () => raw.productUnit.findMany({ where: { productId } });
  const productRow = async () => {
    const row = await raw.product.findUniqueOrThrow({ where: { id: productId } });
    return {
      ...row,
      pricePerUnit: String(row.pricePerUnit),
      priceTier2: row.priceTier2 == null ? null : String(row.priceTier2),
      priceTier3: row.priceTier3 == null ? null : String(row.priceTier3),
      priceTier4: row.priceTier4 == null ? null : String(row.priceTier4),
      priceTier5: row.priceTier5 == null ? null : String(row.priceTier5),
    };
  };

  /** Order path: the real ladder rows and product row through buildUnitLine, persisted as an OrderItem. */
  async function sellLine(item: Record<string, unknown>) {
    const product = await productRow();
    const ladder = (await ladderRows()) as unknown as LadderUnit[];
    const built = buildUnitLine({
      product,
      units: ladder,
      resolved: resolveLineUnits(product, ladder, { unitLabel: "Case" }),
      item: { productId, qty: 3, unitLabel: "Case", ...item },
      tier: 3,
      taxFor: (qty, sub) => categoryTaxForLine(null, qty, sub),
      position: 0,
      tenantId,
      overriddenBy: userId,
    });
    const row = await raw.orderItem.create({
      data: { ...built, orderId, productId, tenantId } as never,
    });
    return raw.orderItem.findUniqueOrThrow({ where: { id: row.id } });
  }

  /** Invoice path: the same input through buildInvoiceUnitLine, persisted as an InvoiceItem. */
  async function invoiceLine(unitPrice: number) {
    const product = await productRow();
    const ladder = (await ladderRows()) as unknown as LadderUnit[];
    const built = buildInvoiceUnitLine({
      item: { description: "Widget", productId, qty: 3, unitPrice, unitLabel: "Case" },
      product,
      resolved: resolveLineUnits(product, ladder, { unitLabel: "Case" }),
      category: null,
      tenantId,
    });
    const row = await raw.invoiceItem.create({
      data: { ...built, invoiceId, productId, tenantId } as never,
    });
    return raw.invoiceItem.findUniqueOrThrow({ where: { id: row.id } });
  }

  const money = (r: {
    unitPrice: unknown;
    subtotal: unknown;
    qty: unknown;
    boxes: unknown;
    unitsPerBox: unknown;
    unitLabel: unknown;
  }) => ({
    unitPrice: Number(r.unitPrice),
    subtotal: Number(r.subtotal),
    qty: Number(r.qty),
    boxes: r.boxes == null ? null : Number(r.boxes),
    unitsPerBox: r.unitsPerBox == null ? null : Number(r.unitsPerBox),
    unitLabel: r.unitLabel,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `H3 ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: {
          email: `h3-${run}@example.test`,
          username: `h3-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: "H3 co", contactName: "Tester", pricingTier: 3, tenantId },
      })
    ).id;
    orderId = (await raw.order.create({ data: { customerId, tenantId, total: "0.00" } })).id;
    invoiceId = (
      await raw.invoice.create({
        data: {
          tenantId,
          customerId,
          invoiceNumber: `INV-H3-${run}`,
          status: "DRAFT",
          subtotal: 0,
          total: 0,
        },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Widget ${run}`,
          unit: "Box",
          pricePerUnit: "1.00",
          unitsPerBox: 24,
          tenantId,
        },
      })
    ).id;
    await raw.productUnit.create({
      data: {
        tenantId,
        productId,
        label: "Case",
        factorToBase: 288,
        price: "24.00",
        priceTier3: "20.00",
      },
    });
  }, 120_000);

  afterAll(async () => {
    await raw?.invoiceItem.deleteMany({ where: { invoiceId } });
    await raw?.invoice.deleteMany({ where: { id: invoiceId } });
    await raw?.orderItem.deleteMany({ where: { orderId } });
    await raw?.order.deleteMany({ where: { id: orderId } });
    await raw?.productUnit.deleteMany({ where: { productId } });
    await raw?.product.deleteMany({ where: { id: productId } });
    await raw?.customer.deleteMany({ where: { id: customerId } });
    await raw?.user.deleteMany({ where: { id: userId } });
    await raw?.tenant.deleteMany({ where: { id: tenantId } });
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("P1: typed list price + reason — both rows read back $24 / $72; the order line is MANUAL with the reason and the user", async () => {
    const order = await sellLine({ unitPrice: 24, overrideReason: "agreed at list" });
    const invoice = await invoiceLine(24);
    expect(money(order)).toEqual(money(invoice));
    expect(money(order)).toMatchObject({ unitPrice: 24, subtotal: 72, boxes: 3 });
    expect(order).toMatchObject({
      priceType: "MANUAL",
      overrideReason: "agreed at list",
      overriddenBy: userId,
    });
    expect(Number(order.originalPrice)).toBe(24);
  });

  it("P2: typed tier price — both rows read back $20 / $60; the order line is SPECIAL with no reason and no stamp", async () => {
    const order = await sellLine({ unitPrice: 20 });
    const invoice = await invoiceLine(20);
    expect(money(order)).toEqual(money(invoice));
    expect(money(order)).toMatchObject({ unitPrice: 20, subtotal: 60 });
    expect(order).toMatchObject({ priceType: "SPECIAL", overrideReason: null, overriddenBy: null });
  });

  it("P3: typed list price with NO reason on a special tier — the order builder refuses (400) and writes nothing", async () => {
    const before = await raw.orderItem.count({ where: { orderId } });
    await expect(sellLine({ unitPrice: 24 })).rejects.toBeInstanceOf(BadRequestException);
    expect(await raw.orderItem.count({ where: { orderId } })).toBe(before);
    // the manual invoice has no reason column: it stores the typed price verbatim
    expect(money(await invoiceLine(24))).toMatchObject({ unitPrice: 24, subtotal: 72 });
  });
});
