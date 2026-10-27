/**
 * B297 PR4a, Opus review of #3726 (test 5c): a ledger re-sync after a RECEIVED return, on lines that bill the
 * DELIVERED quantity, writes nothing. The return's reduction stands; nothing is re-billed.
 *
 * Fixture: an order line ordered at 12 and delivered at 10 (`deliveredQty`), invoiced at the delivered 10
 * (net 100.00, tax 20.00); its SALE booked through `settleRegulatedLedger({ kind: "INVOICE_BILLED" })`; a
 * RECEIVED return of 3 booked through the real `reverseReturnEntries`. Then the reconcile / price re-sync runs
 * `INVOICE_BILLED` again with the SAME delivered line. `syncInvoiceEntries` nets with `preserveReturns`, so the
 * held sale-record (10) equals the target (10): no row is written, and the return's REVERSAL still stands
 * (net remaining 7 / 70.00 / 14.00).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * SAFETY: a throwaway `qa-b297r-<run>` tenant (`assertTestTenant`); `afterAll` deletes exactly the rows this
 * run created, in FK order. NOT run on the MacBook (no Postgres): the Windows DB lane runs it.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedLedgerService, type SaleLedgerLine } from "./regulated-ledger.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "Real-Postgres: a re-sync after a received return, delivered-basis lines (B297 PR4a)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let ledger: RegulatedLedgerService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(
      `qa-b297r-${run}`,
      "regulated-ledger.resync-after-return.db.spec.ts",
    );
    let tenantId = "";
    let categoryId = "";
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
      tenantId = (await raw.tenant.create({ data: { slug, name: `B297r ${slug}` } })).id;
      categoryId = (
        await raw.trackedCategory.create({ data: { name: "Tobacco", taxType: "NONE", tenantId } })
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
            businessName: "Acme Retail",
            contactName: "Acme Retail",
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      await raw.auditLog.deleteMany({ where: { tenantId } });
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

    it("settleRegulatedLedger INVOICE_BILLED after a received return writes nothing: the return stands, nothing is re-billed", async () => {
      const product = await raw.product.create({
        data: {
          name: `b297r delivered ${run}`,
          unit: "pack",
          pricePerUnit: "10.00",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      productIds.push(product.id);
      const order = await raw.order.create({
        data: { customerId, status: "DELIVERED", subtotal: "100", total: "100", tenantId },
      });
      orderIds.push(order.id);
      // ordered 12, delivered 10: the invoice bills the DELIVERED basis
      const orderItem = await raw.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "DELIVERED",
          qty: 12,
          deliveredQty: 10,
          unitPrice: "10.00",
          subtotal: "100",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-B297R-${run}`,
          customerId,
          orderId: order.id,
          status: "SENT",
          subtotal: "100",
          taxAmount: "0",
          total: "100",
          tenantId,
        },
      });
      invoiceIds.push(invoice.id);
      const item = await raw.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          description: "b297r delivered",
          productId: product.id,
          orderItemId: orderItem.id,
          qty: 10,
          unitPrice: "10.00",
          subtotal: "100",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const line: SaleLedgerLine = {
        invoiceItemId: item.id,
        orderItemId: orderItem.id,
        trackedCategoryId: categoryId,
        qty: 10,
        netSales: 100,
        categoryTax: 20,
      };
      const billed = () =>
        tenantCtx.run(tenantId, () =>
          ledger.settleRegulatedLedger(prisma.forTenant(), {
            kind: "INVOICE_BILLED",
            invoiceId: invoice.id,
            orderId: order.id,
            tenantId,
            lines: [line],
          }),
        );

      // 1. the delivered quantity is billed: one SALE row of 10
      expect((await billed()).written).toBe(1);

      // 2. a RECEIVED return of 3 books its REVERSAL through the real writer
      const ret = await raw.return.create({
        data: {
          orderId: order.id,
          customerId,
          reason: "EXCESS_ORDER",
          status: "RECEIVED",
          tenantId,
        },
      });
      await tenantCtx.run(tenantId, () =>
        ledger.reverseReturnEntries({
          returnId: ret.id,
          orderId: order.id,
          returnedByProduct: new Map([[product.id, 3]]),
          returnedUnit: "LINE_UNIT",
          db: prisma.forTenant(),
        }),
      );
      const before = await raw.regulatedSalesLedger.findMany({
        where: { invoiceId: invoice.id },
        orderBy: { id: "asc" },
      });
      const sum = (rows: typeof before, k: "qty" | "netSales" | "categoryTax") =>
        rows.reduce((n, r) => n + Number(r[k]), 0);
      expect(before.map((r) => r.entryType).sort()).toEqual(["REVERSAL", "SALE"]);
      expect(sum(before, "qty")).toBe(7); // 10 sold - 3 returned
      expect(sum(before, "netSales")).toBeCloseTo(70, 2);
      expect(sum(before, "categoryTax")).toBeCloseTo(14, 2);

      // 3. the re-sync (a reconcile / note edit / price re-sync) of the SAME delivered line writes nothing, twice
      expect((await billed()).written).toBe(0);
      expect((await billed()).written).toBe(0);
      const after = await raw.regulatedSalesLedger.findMany({
        where: { invoiceId: invoice.id },
        orderBy: { id: "asc" },
      });
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id)); // no row added, none changed
      expect(sum(after, "qty")).toBe(7); // the return still stands
      expect(after.filter((r) => r.entryType === "SALE")).toHaveLength(1); // nothing re-billed
      expect(after.filter((r) => r.returnId === ret.id)).toHaveLength(1);
    }, 120_000);
  },
);
