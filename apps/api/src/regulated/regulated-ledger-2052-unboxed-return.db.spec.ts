/**
 * #2052 / SA-609 — real-Postgres red pin: a product sold as 3 boxes of 12 on a legacy (pre-B661)
 * box-axis SALE row (qty 3 / unitBasisQty 3, createdAt back-dated before B661_CUTOFF, the line
 * carrying NO unitsPerBox snapshot) is then UN-BOXED (live unitsPerBox null). A live 36-PIECE return
 * through the real `reverseReturnEntries` must PARK (36 pieces) and write ZERO reversal rows — today
 * it books 3 pieces. Resolving the park with pack 12 then books the 36 pieces and the line ends at 0.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * SAFETY: a throwaway `qa-unboxed-<run>` tenant (`assertTestTenant`); `afterAll` deletes exactly the
 * rows this run created, in FK order.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { ParkedReversalResolutionService } from "./parked-reversal-resolution.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("Real-Postgres — a return on a product un-boxed since the sale (#2052)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let ledger: RegulatedLedgerService;
  let svc: ParkedReversalResolutionService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-unboxed-${run}`,
    "regulated-ledger-2052-unboxed-return.db.spec.ts",
  );
  let tenantId = "";
  let categoryId = "";
  let userId = "";
  let customerId = "";
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  const productIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    ledger = new RegulatedLedgerService(prisma);
    svc = Object.assign(Object.create(ParkedReversalResolutionService.prototype), {
      prisma,
      ledger,
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `Unboxed ${slug}` } })).id;
    categoryId = (
      await raw.trackedCategory.create({ data: { name: "Tobacco", taxType: "NONE", tenantId } })
    ).id;
    userId = (
      await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
    const custUser = await raw.user.create({
      data: {
        email: `cust-${run}@example.test`,
        username: `cust-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await raw.customer.create({
        data: {
          userId: custUser.id,
          businessName: "Unboxed Co",
          contactName: "Unboxed Co",
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.regulatedLedgerParkedReversal.deleteMany({ where: { tenantId } });
    await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
    for (const orderId of orderIds) await raw.return.deleteMany({ where: { orderId } });
    await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.trackedCategory.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("REG-2052: 36 pieces back on a pre-cutoff snapshot-less 3-box line of a now un-boxed product PARKS (36) with zero reversal rows; resolving at pack 12 books 36 and the line ends at 0", async () => {
    // The product was un-boxed AFTER the sale: live unitsPerBox is null.
    const product = await raw.product.create({
      data: {
        name: "unboxed product",
        unit: "box",
        pricePerUnit: "10.00",
        unitsPerBox: null,
        trackedCategoryId: categoryId,
        tenantId,
      },
    });
    productIds.push(product.id);
    const order = await raw.order.create({
      data: { customerId, status: "DELIVERED", subtotal: "30", total: "36", tenantId },
    });
    orderIds.push(order.id);
    const orderItem = await raw.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        status: "DELIVERED",
        qty: 3,
        unitPrice: "10",
        subtotal: "30",
        categoryTaxAmount: "6",
        trackedCategoryId: categoryId,
        tenantId,
      },
    });
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-UNBOXED-${run}`,
        customerId,
        orderId: order.id,
        status: "SENT",
        subtotal: "30",
        taxAmount: "6",
        total: "36",
        tenantId,
      },
    });
    invoiceIds.push(invoice.id);
    // NO unitsPerBox snapshot on the line (snapshot-less), no split, no unit label.
    const invoiceItem = await raw.invoiceItem.create({
      data: {
        invoiceId: invoice.id,
        description: "unboxed product",
        productId: product.id,
        orderItemId: orderItem.id,
        qty: 3,
        unitPrice: "10",
        subtotal: "30",
        categoryTaxAmount: "6",
        trackedCategoryId: categoryId,
        tenantId,
      },
    });
    const sale = await raw.regulatedSalesLedger.create({
      data: {
        tenantId,
        trackedCategoryId: categoryId,
        entryType: "SALE",
        orderId: order.id,
        orderItemId: orderItem.id,
        invoiceId: invoice.id,
        invoiceItemId: invoiceItem.id,
        qty: 3,
        unitBasisQty: 3, // 3 boxes of 12, stored as 3 "pieces" (the pre-B661 shape)
        netSales: 30,
        categoryTax: 6,
        soldAt: new Date("2026-09-10T00:00:00Z"),
        periodBucket: "2026-09",
      },
    });
    // The WRITE time is what classifySaleAxis reads: back-date it before B661_CUTOFF.
    await raw.regulatedSalesLedger.update({
      where: { id: sale.id },
      data: { createdAt: new Date("2026-09-10T00:00:00Z") },
    });
    const ret = await raw.return.create({
      data: { orderId: order.id, customerId, reason: "EXCESS_ORDER", status: "RECEIVED", tenantId },
    });

    // The real live return path: 36 PIECES back.
    await tenantCtx.run(tenantId, () =>
      ledger.reverseReturnEntries({
        returnId: ret.id,
        orderId: order.id,
        returnedByProduct: new Map([[product.id, 36]]),
        returnedUnit: "PIECES",
        db: prisma.forTenant(),
      }),
    );

    // Today: a REVERSAL of 3 pieces is booked. Expected: parked, nothing booked.
    const reversals = await raw.regulatedSalesLedger.findMany({
      where: { orderItemId: orderItem.id, entryType: "REVERSAL" },
    });
    expect(reversals.map((r) => Number(r.unitBasisQty))).toEqual([]);
    const parked = await raw.regulatedLedgerParkedReversal.findMany({
      where: { returnId: ret.id },
    });
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ saleEntryId: sale.id, resolvedAt: null });
    // returnedPieces is Decimal(10,3) on Postgres: compare the number, never the Decimal object.
    expect(Number(parked[0].returnedPieces)).toBe(36);

    // Resolve with the operator pack 12 -> books the 36 pieces; the line ends at 0.
    const result = await tenantCtx.run(tenantId, () =>
      svc.resolve(parked[0].id, 12, "operator confirmed", { id: userId }),
    );
    expect(result.outcome).toBe("booked");
    expect(result.bookedPieces).toBe(36);
    const rows = await raw.regulatedSalesLedger.findMany({ where: { orderItemId: orderItem.id } });
    const booked = rows.filter((r) => r.entryType === "REVERSAL" && r.correctsEntryId == null);
    expect(booked.map((r) => Number(r.unitBasisQty))).toEqual([-36]);
    expect(rows.reduce((s, r) => s + Number(r.unitBasisQty), 0)).toBe(0); // line remaining 0
  }, 60_000);
});
