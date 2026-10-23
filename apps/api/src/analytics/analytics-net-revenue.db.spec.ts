/**
 * DB-lane spec for the SA-859 row-based net-sales readers against a REAL Postgres: the nested selects
 * (invoice items, credit-note items through the credit note's invoice, inline-return items) are shapes only a real
 * schema can check. Collected by `jest.db.config.js`, run via `npm run local:test:db`. Own qa- tenant, cleaned up after.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  fetchAccrualNetSales,
  fetchAccrualNetSalesByCustomerRows,
  fetchAccrualNetSalesByPeriod,
} from "../common/invoiced-sales";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const WINDOW = {
  gte: new Date("2026-10-01T00:00:00.000Z"),
  lte: new Date("2026-10-31T23:59:59.999Z"),
};

describeDb("accrual net-sales row readers, real Postgres (SA-859)", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let tenantId = "";
  let customerId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const slug = assertTestTenant(`qa-netrev-${RUN}`, "analytics-net-revenue.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `netrev ${slug}` } })).id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "netrev", contactName: "netrev", tenantId } as any,
      })
    ).id;
    const tob = await prisma.product.create({
      data: {
        name: `Cigars ${RUN}`,
        unit: "Each",
        pricePerUnit: "10",
        currentStock: "100",
        isTobacco: true,
        tenantId,
      } as any,
    });
    const plain = await prisma.product.create({
      data: {
        name: `Bread ${RUN}`,
        unit: "Each",
        pricePerUnit: "10",
        currentStock: "100",
        tenantId,
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-NETREV-${RUN}`,
        status: "SENT",
        issueDate: new Date("2026-10-05T00:00:00.000Z"),
        subtotal: 200,
        taxAmount: 20,
        total: 220,
      } as any,
    });
    const tobLine = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: tob.id,
        description: "Cigars",
        qty: 1,
        unitPrice: 60,
        subtotal: 60,
      } as any,
    });
    await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: plain.id,
        description: "Bread",
        qty: 1,
        unitPrice: 140,
        subtotal: 140,
      } as any,
    });
    const lineCredit = await prisma.creditNote.create({
      data: {
        tenantId,
        customerId,
        invoiceId: invoice.id,
        creditNoteNumber: `CN-NETREV-${RUN}-1`,
        status: "ISSUED",
        amount: 20,
        createdAt: new Date("2026-10-10T15:00:00.000Z"),
      } as any,
    });
    await prisma.creditNoteItem.create({
      data: { tenantId, creditNoteId: lineCredit.id, invoiceItemId: tobLine.id, amount: 20 } as any,
    });
    await prisma.creditNote.create({
      data: {
        tenantId,
        customerId,
        invoiceId: null,
        creditNoteNumber: `CN-NETREV-${RUN}-2`,
        status: "ISSUED",
        amount: 15,
        createdAt: new Date("2026-10-11T15:00:00.000Z"),
      } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId,
        orderNumber: `ORD-NETREV-${RUN}`,
        subtotal: 5,
        tax: 0,
        total: 5,
        status: "DELIVERED",
      } as any,
    });
    const ret = await prisma.return.create({
      data: {
        tenantId,
        customerId,
        orderId: order.id,
        returnNumber: `RET-NETREV-${RUN}`,
        reason: "DAMAGED",
        status: "REFUNDED",
        kind: "INLINE",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 5,
        refundedAt: new Date("2026-10-12T15:00:00.000Z"),
      } as any,
    });
    await prisma.returnItem.create({
      data: { tenantId, returnId: ret.id, productId: tob.id, qty: 1, subtotal: 5 } as any,
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    await prisma.returnItem.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.return.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.creditNoteItem.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.creditNote.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.invoiceItem.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.invoice.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.order.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.product.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma.$disconnect();
    await pool.end().catch(swallow);
  });

  it("the period bucket equals fetchAccrualNetSales (parity), switch off", async () => {
    const buckets = await fetchAccrualNetSalesByPeriod(prisma as any, tenantId, WINDOW, {
      groupBy: "month",
    });
    const b = buckets.get("2026-10")!;
    const net = await fetchAccrualNetSales(prisma as any, tenantId, WINDOW);
    expect(b).toMatchObject({
      gross: 200,
      creditNotes: 35,
      externalRefunds: 5,
      net: 160,
      orderCount: 1,
    });
    expect(b.net).toBe(net.net);
  });

  it("tobacco switch on: the tobacco line, its line credit and its inline return leave; a freeform credit stays", async () => {
    const buckets = await fetchAccrualNetSalesByPeriod(prisma as any, tenantId, WINDOW, {
      groupBy: "month",
      excludeTobacco: true,
    });
    expect(buckets.get("2026-10")).toMatchObject({
      gross: 140,
      creditNotes: 15,
      externalRefunds: 0,
      net: 125,
    });
  });

  it("per customer rows read the same predicates and count the invoice", async () => {
    const byCustomer = await fetchAccrualNetSalesByCustomerRows(prisma as any, tenantId, WINDOW, {
      excludeTobacco: true,
    });
    expect(byCustomer.get(customerId)).toMatchObject({ net: 125, orderCount: 1 });
  });
});
