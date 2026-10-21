/**
 * SA-789 F1 (row 558) real-Postgres twins of regulated-ledger.sa789.spec.ts: a SALE row whose invoice item
 * was re-created (fresh id, the old one deleted) is still reversed by a return and by a credit note through
 * its order line, and a reversal that cannot be booked at all raises a notice that the period report counts.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * SAFETY: a throwaway `qa-sa789-<run>` tenant (`assertTestTenant`); `afterAll` deletes exactly the rows
 * this run created, in FK order.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { countUnbookedReversals } from "./unbooked-reversals";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "Real-Postgres: a regulated SALE row whose invoice item was re-created (SA-789 F1)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let ledger: RegulatedLedgerService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-sa789-${run}`, "regulated-ledger.sa789.db.spec.ts");
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
      tenantId = (await raw.tenant.create({ data: { slug, name: `Sa789 ${slug}` } })).id;
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
      await raw.creditNoteItem.deleteMany({ where: { tenantId } });
      await raw.creditNote.deleteMany({ where: { tenantId } });
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

    /** Order + invoice + one regulated line (75 units, net 87.50), its SALE row, then the legacy rebuild:
     *  the invoice item is deleted and re-created under a fresh id. The SALE keeps the OLD id. */
    async function rotatedSale(tag: string, opts: { deleteOrderLine?: boolean } = {}) {
      const product = await raw.product.create({
        data: {
          name: `sa789 ${tag}`,
          unit: "pack",
          pricePerUnit: "1.00",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      productIds.push(product.id);
      const order = await raw.order.create({
        data: { customerId, status: "DELIVERED", subtotal: "87.5", total: "87.5", tenantId },
      });
      orderIds.push(order.id);
      const orderItem = await raw.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "DELIVERED",
          qty: 75,
          unitPrice: "1.1667",
          subtotal: "87.5",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-SA789-${tag}-${run}`,
          customerId,
          orderId: order.id,
          status: "SENT",
          subtotal: "87.5",
          taxAmount: "0",
          total: "87.5",
          tenantId,
        },
      });
      invoiceIds.push(invoice.id);
      const lineData = {
        invoiceId: invoice.id,
        description: `sa789 ${tag}`,
        productId: product.id,
        orderItemId: orderItem.id,
        qty: 75,
        unitPrice: "1.1667",
        subtotal: "87.5",
        trackedCategoryId: categoryId,
        tenantId,
      };
      const oldItem = await raw.invoiceItem.create({ data: lineData });
      const sale = await raw.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          entryType: "SALE",
          orderId: order.id,
          orderItemId: orderItem.id,
          invoiceId: invoice.id,
          invoiceItemId: oldItem.id,
          qty: 75,
          unitBasisQty: 75,
          netSales: 87.5,
          categoryTax: 0,
          soldAt: new Date(),
          periodBucket: new Date().toISOString().slice(0, 7),
        },
      });
      // The legacy rebuild: every item deleted and re-created under a fresh id; the ledger is left alone.
      await raw.invoiceItem.delete({ where: { id: oldItem.id } });
      const newItem = await raw.invoiceItem.create({ data: lineData });
      if (opts.deleteOrderLine) {
        await raw.invoiceItem.delete({ where: { id: newItem.id } });
        await raw.orderItem.delete({ where: { id: orderItem.id } });
      }
      return { product, order, orderItem, invoice, oldItem, newItem, sale };
    }

    const dayRange = () => ({
      from: new Date(Date.now() - 86_400_000),
      toExclusive: new Date(Date.now() + 86_400_000),
    });

    it("R1: a return of 10 units books a REVERSAL of 10 through the order line", async () => {
      const f = await rotatedSale("r1");
      const ret = await raw.return.create({
        data: {
          orderId: f.order.id,
          customerId,
          reason: "EXCESS_ORDER",
          status: "RECEIVED",
          tenantId,
        },
      });
      await tenantCtx.run(tenantId, () =>
        ledger.reverseReturnEntries({
          returnId: ret.id,
          orderId: f.order.id,
          returnedByProduct: new Map([[f.product.id, 10]]),
          returnedUnit: "PIECES",
          db: prisma.forTenant(),
        }),
      );
      const reversals = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItem.id, entryType: "REVERSAL" },
      });
      expect(reversals.map((r) => Number(r.unitBasisQty))).toEqual([-10]);
      expect(reversals[0].returnId).toBe(ret.id);
    }, 60_000);

    it("R2: a credit note of 10 on the re-created line books a REVERSAL of 10 through the order line", async () => {
      const f = await rotatedSale("r2");
      const cn = await raw.creditNote.create({
        data: {
          creditNoteNumber: `CN-SA789-${run}`,
          customerId,
          invoiceId: f.invoice.id,
          amount: "11.67",
          tenantId,
        },
      });
      await raw.creditNoteItem.create({
        data: {
          tenantId,
          creditNoteId: cn.id,
          invoiceItemId: f.newItem.id,
          trackedCategoryId: categoryId,
          amount: "11.67",
          qty: 10,
          categoryTax: "0",
        },
      });
      await tenantCtx.run(tenantId, () =>
        ledger.reverseCreditNoteEntries({ creditNoteId: cn.id, db: prisma.forTenant() }),
      );
      const reversals = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItem.id, entryType: "REVERSAL" },
      });
      expect(reversals.map((r) => Number(r.qty))).toEqual([-10]);
      expect(reversals.map((r) => Number(r.netSales))).toEqual([-11.67]);
      expect(reversals[0].creditNoteId).toBe(cn.id);
    }, 60_000);

    it("a return of an unresolvable SALE row succeeds, writes the notice, and the period count rises by 1", async () => {
      const before = await tenantCtx.run(tenantId, () =>
        countUnbookedReversals(prisma.forTenant(), dayRange()),
      );
      const f = await rotatedSale("r3", { deleteOrderLine: true });
      const ret = await raw.return.create({
        data: {
          orderId: f.order.id,
          customerId,
          reason: "EXCESS_ORDER",
          status: "RECEIVED",
          tenantId,
        },
      });
      await tenantCtx.run(tenantId, () =>
        ledger.reverseReturnEntries({
          returnId: ret.id,
          orderId: f.order.id,
          returnedByProduct: new Map([[f.product.id, 10]]),
          returnedUnit: "PIECES",
          db: prisma.forTenant(),
        }),
      );
      const reversals = await raw.regulatedSalesLedger.findMany({
        where: { orderId: f.order.id, entryType: "REVERSAL" },
      });
      expect(reversals).toHaveLength(0);
      const notices = await raw.auditLog.findMany({
        where: { tenantId, action: "REGULATED_REVERSAL_UNBOOKED" },
      });
      expect(notices.some((n) => (n.meta as any)?.returnId === ret.id)).toBe(true);
      const after = await tenantCtx.run(tenantId, () =>
        countUnbookedReversals(prisma.forTenant(), dayRange()),
      );
      expect(after - before).toBe(1);
    }, 60_000);
  },
);
