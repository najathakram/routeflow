/**
 * SA-835 (row 558, builder C fold 1791fe249) real-Postgres twins: the unbooked-reversal notice is written ONCE
 * per (return, sale entry) even when the return is retried (a JSON-path lookup on AuditLog.meta, real
 * Postgres only), and the period count is tenant-scoped and counts distinct returns, not notice rows. The
 * period is part of the dedupe key (19b05ebe5): a return re-received unreversed in a later month notices again.
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
  "Real-Postgres: unbooked-reversal notices are written once and counted per tenant, per return (SA-835)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let ledger: RegulatedLedgerService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-sa835-${run}`, "regulated-unbooked-notice.sa835.db.spec.ts");
    let tenantId = "";
    const otherSlug = assertTestTenant(
      `qa-sa835-${run}-b`,
      "regulated-unbooked-notice.sa835.db.spec.ts",
    );
    let otherTenantId = "";
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
      tenantId = (await raw.tenant.create({ data: { slug, name: `Sa835 ${slug}` } })).id;
      otherTenantId = (
        await raw.tenant.create({ data: { slug: otherSlug, name: `Sa835 ${otherSlug}` } })
      ).id;
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
      await raw.auditLog.deleteMany({ where: { tenantId: otherTenantId } });
      await raw.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    /** Order + invoice + one regulated line (75 units, net 87.50), its SALE row, then the legacy rebuild:
     *  the invoice item is deleted and re-created under a fresh id. The SALE keeps the OLD id. */
    async function rotatedSale(tag: string, opts: { deleteOrderLine?: boolean } = {}) {
      const product = await raw.product.create({
        data: {
          name: `sa835 ${tag}`,
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
          invoiceNumber: `INV-SA835-${tag}-${run}`,
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
        description: `sa835 ${tag}`,
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

    /** A second regulated line on `f`'s order (product B), with its SALE row, then the line deleted: unresolvable too. */
    async function secondUnresolvableSale(f: Awaited<ReturnType<typeof rotatedSale>>, tag: string) {
      const product = await raw.product.create({
        data: {
          name: `sa835 ${tag} B`,
          unit: "pack",
          pricePerUnit: "1.00",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      productIds.push(product.id);
      const orderItem = await raw.orderItem.create({
        data: {
          orderId: f.order.id,
          productId: product.id,
          status: "DELIVERED",
          qty: 75,
          unitPrice: "1.1667",
          subtotal: "87.5",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const item = await raw.invoiceItem.create({
        data: {
          invoiceId: f.invoice.id,
          description: `sa835 ${tag} B`,
          productId: product.id,
          orderItemId: orderItem.id,
          qty: 75,
          unitPrice: "1.1667",
          subtotal: "87.5",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const sale = await raw.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          entryType: "SALE",
          orderId: f.order.id,
          orderItemId: orderItem.id,
          invoiceId: f.invoice.id,
          invoiceItemId: item.id,
          qty: 75,
          unitBasisQty: 75,
          netSales: 87.5,
          categoryTax: 0,
          soldAt: new Date(),
          periodBucket: new Date().toISOString().slice(0, 7),
        },
      });
      await raw.invoiceItem.delete({ where: { id: item.id } });
      await raw.orderItem.delete({ where: { id: orderItem.id } });
      return { product, sale };
    }

    const newReturn = async (orderId: string) =>
      raw.return.create({
        data: { orderId, customerId, reason: "EXCESS_ORDER", status: "RECEIVED", tenantId },
      });
    const reverse = (retId: string, orderId: string, byProduct: Map<string, number>) =>
      tenantCtx.run(tenantId, () =>
        ledger.reverseReturnEntries({
          returnId: retId,
          orderId,
          returnedByProduct: byProduct,
          returnedUnit: "PIECES",
          db: prisma.forTenant(),
        }),
      );
    const noticesFor = async (retId: string) =>
      (
        await raw.auditLog.findMany({
          where: { tenantId, action: "REGULATED_REVERSAL_UNBOOKED" },
        })
      ).filter((n) => (n.meta as any)?.returnId === retId);
    const count = () =>
      tenantCtx.run(tenantId, () =>
        countUnbookedReversals(prisma.forTenant(), dayRange(), tenantId),
      );

    it("REG: a retried unresolvable return writes ONE notice and the period count rises by 1, not 2", async () => {
      const before = await count();
      const f = await rotatedSale("retry", { deleteOrderLine: true });
      const ret = await newReturn(f.order.id);
      await reverse(ret.id, f.order.id, new Map([[f.product.id, 10]]));
      await reverse(ret.id, f.order.id, new Map([[f.product.id, 10]]));
      const notices = await noticesFor(ret.id);
      expect(notices).toHaveLength(1);
      expect((notices[0].meta as any)?.saleEntryId).toBe(f.sale.id);
      expect((await count()) - before).toBe(1);
    }, 60_000);

    it("REG: another tenant's notice is not counted (forTenant client AND an unscoped super-admin client)", async () => {
      const scoped = await count();
      const unscoped = await countUnbookedReversals(prisma, dayRange(), tenantId);
      await raw.auditLog.create({
        data: {
          tenantId: otherTenantId,
          action: "REGULATED_REVERSAL_UNBOOKED",
          entityType: "Return",
          entityId: randomUUID(),
          meta: { returnId: randomUUID(), creditNoteId: null, saleEntryId: randomUUID() },
        },
      });
      expect(await count()).toBe(scoped);
      expect(await countUnbookedReversals(prisma, dayRange(), tenantId)).toBe(unscoped);
    }, 60_000);

    it("REG: two different sale entries on one return write TWO notices but count ONE return", async () => {
      const before = await count();
      const f = await rotatedSale("two", { deleteOrderLine: true });
      const b = await secondUnresolvableSale(f, "two");
      const ret = await newReturn(f.order.id);
      await reverse(
        ret.id,
        f.order.id,
        new Map([
          [f.product.id, 10],
          [b.product.id, 5],
        ]),
      );
      const notices = await noticesFor(ret.id);
      expect(notices.map((n) => (n.meta as any)?.saleEntryId).sort()).toEqual(
        [f.sale.id, b.sale.id].sort(),
      );
      expect((await count()) - before).toBe(1);
    }, 60_000);

    it("REG: noticed in month M, re-received unreversed in M+1 → a second notice in M+1, and M+1 counts 1", async () => {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const nextStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const prevMid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
      const f = await rotatedSale("months", { deleteOrderLine: true });
      const ret = await newReturn(f.order.id);
      await reverse(ret.id, f.order.id, new Map([[f.product.id, 10]]));
      // Month M: move that notice to the previous month, as if it had been written then.
      const [first] = await noticesFor(ret.id);
      const prevPeriod = prevMid.toISOString().slice(0, 7);
      await raw.auditLog.update({
        where: { id: first.id },
        data: { createdAt: prevMid, meta: { ...(first.meta as object), period: prevPeriod } },
      });
      const countIn = (from: Date, toExclusive: Date) =>
        tenantCtx.run(tenantId, () =>
          countUnbookedReversals(prisma.forTenant(), { from, toExclusive }, tenantId),
        );
      const thisMonthBefore = await countIn(monthStart, nextStart);
      // Month M+1 (now): the same return is re-received, still unreversed.
      await reverse(ret.id, f.order.id, new Map([[f.product.id, 10]]));
      const notices = await noticesFor(ret.id);
      expect(notices.map((n) => (n.meta as any)?.period).sort()).toEqual(
        [prevPeriod, now.toISOString().slice(0, 7)].sort(),
      );
      expect((await countIn(monthStart, nextStart)) - thisMonthBefore).toBe(1);
      expect(await countIn(prevStart, monthStart)).toBe(1);
    }, 60_000);
  },
);
