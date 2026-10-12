/**
 * B297 row 341 (delta review fold) — real Postgres. A line is SOLD (10 units, 10 pieces), re-synced in place by a
 * same-key REVERSAL, and BOOKED AGAIN after a repack (10 units, 120 pieces). The offset first sale must never price
 * the piece axis of a later credit note or return (-32.5 / -5 pieces instead of -60).
 *
 * WHY THE DB LANE: the credit path reads its rows through Prisma `select`s; a unit-test mock that ignores `select`
 * let a missing `id` / `createdAt` make `deadSaleIdsOf` inert in production. Collected only by `jest.db.config.js`.
 *
 * SAFETY: throwaway `qa-b341d-<run>-<n>-<label>` tenants approved by `assertTestTenant`; `afterAll` deletes them.
 */

import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b341d-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "regulated-ledger-superseded-sale.db.spec.ts",
  );
}

type Bag = { qty: number; basis: number; net: number; tax: number };
const bagOf = (rows: any[]): Bag =>
  rows.reduce(
    (b, r) => ({
      qty: round3(b.qty + Number(r.qty)),
      basis: round3(b.basis + Number(r.unitBasisQty)),
      net: round2(b.net + Number(r.netSales)),
      tax: round2(b.tax + Number(r.categoryTax)),
    }),
    { qty: 0, basis: 0, net: 0, tax: 0 },
  );
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

describeDb(
  "B297 row 341 review fold: a sale superseded in place never prices the piece axis — real Postgres",
  () => {
    let prisma: PrismaService;
    let ledger: RegulatedLedgerService;
    const createdTenantIds: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      prisma = new PrismaService(new TenantContextService());
      await prisma.$connect();
      ledger = new RegulatedLedgerService(prisma);
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => {
          // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
        });
      }
      await prisma?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      await prisma.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      await prisma.creditNoteItem.deleteMany({ where: { tenantId } });
      await prisma.creditNote.deleteMany({ where: { tenantId } });
      await prisma.returnItem.deleteMany({ where: { tenantId } });
      await prisma.return.deleteMany({ where: { tenantId } });
      await prisma.invoiceItem.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.orderItem.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.trackedCategory.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }

    /** One regulated SALE (qty 10, $100.00 net, $10.00 tax) on a single order line. */
    async function seedSale(label: string) {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `B341D ${slug}` } });
      createdTenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const idBase = `${tenantId}-${label}`;
      const user = await prisma.user.create({
        data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `B341D customer ${label}`,
          contactName: `B341D contact ${label}`,
          tenantId,
        },
      });
      const category = await prisma.trackedCategory.create({
        data: { tenantId, name: `B341D category ${label}` },
      });
      const product = await prisma.product.create({
        data: { name: `B341D product ${label}`, unit: "each", pricePerUnit: 10, tenantId },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "DELIVERED",
          orderNumber: `B341D-${RUN_SUFFIX}-${label}`,
          subtotal: 100,
          tax: 0,
          total: 110,
          tenantId,
        },
      });
      const orderItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          tenantId,
        },
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-B341D-${RUN_SUFFIX}-${label}`,
          status: "SENT",
          subtotal: 100,
          total: 110,
        },
      });
      const invoiceItem = await prisma.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          orderItemId: orderItem.id,
          productId: product.id,
          description: `B341D line ${label}`,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          trackedCategoryId: category.id,
          categoryTaxAmount: 10,
          tenantId,
        },
      });
      await ledger.writeSaleEntries({
        tenantId,
        orderId: order.id,
        invoiceId: invoice.id,
        soldAt: new Date(),
        db: prisma,
        lines: [
          {
            invoiceItemId: invoiceItem.id,
            orderItemId: orderItem.id,
            trackedCategoryId: category.id,
            qty: 10,
            netSales: 100,
            categoryTax: 10,
          },
        ],
      });
      return { tenantId, customer, category, product, order, orderItem, invoice, invoiceItem };
    }

    type Seed = Awaited<ReturnType<typeof seedSale>>;

    /** A partial return of `qty` units, booked through the real service (LINE_UNIT axis). */
    async function bookReturn(s: Seed, qty: number, label: string) {
      const ret = await prisma.return.create({
        data: {
          tenantId: s.tenantId,
          orderId: s.order.id,
          customerId: s.customer.id,
          reason: "DAMAGED",
          returnNumber: `RET-B341D-${RUN_SUFFIX}-${label}`,
        },
      });
      await prisma.returnItem.create({
        data: { tenantId: s.tenantId, returnId: ret.id, productId: s.product.id, qty },
      });
      await ledger.reverseReturnEntries({
        returnId: ret.id,
        orderId: s.order.id,
        returnedByProduct: new Map([[s.product.id, qty]]),
        returnedUnit: "LINE_UNIT",
        db: prisma,
      });
      return ret;
    }

    /** A credit note crediting `net` (with `qty` units and `tax`) against the sold line. */
    async function bookCredit(s: Seed, net: number, qty: number, tax: number, label: string) {
      const cn = await prisma.creditNote.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customer.id,
          invoiceId: s.invoice.id,
          creditNoteNumber: `CN-B341D-${RUN_SUFFIX}-${label}`,
          amount: net + tax,
        },
      });
      await prisma.creditNoteItem.create({
        data: {
          tenantId: s.tenantId,
          creditNoteId: cn.id,
          invoiceItemId: s.invoiceItem.id,
          trackedCategoryId: s.category.id,
          amount: net,
          qty,
          categoryTax: tax,
        },
      });
      await ledger.reverseCreditNoteEntries({ creditNoteId: cn.id, db: prisma });
      return cn;
    }

    const allRows = (s: Seed) =>
      prisma.regulatedSalesLedger.findMany({
        where: { tenantId: s.tenantId, orderItemId: s.orderItem.id },
        orderBy: { createdAt: "asc" },
      });
    /** The line's remaining balance: Σ(SALE + REVERSAL), signed. */
    const remaining = async (s: Seed): Promise<Bag> => bagOf(await allRows(s));
    const reversalsOf = async (s: Seed, key: "returnId" | "creditNoteId", id: string) =>
      bagOf((await allRows(s)).filter((r) => r.entryType === "REVERSAL" && r[key] === id));

    /** Re-sync the line in place: REVERSAL the first SALE (no returnId / creditNoteId), then book it again at 120 pieces. */
    async function repack(s: Seed) {
      const sale = await prisma.regulatedSalesLedger.findFirstOrThrow({
        where: { tenantId: s.tenantId, orderItemId: s.orderItem.id, entryType: "SALE" },
      });
      const t0 = new Date(sale.createdAt.getTime() + 1000);
      await prisma.regulatedSalesLedger.create({
        data: {
          tenantId: s.tenantId,
          trackedCategoryId: sale.trackedCategoryId,
          trackedSubcategoryId: sale.trackedSubcategoryId,
          entryType: "REVERSAL",
          orderId: sale.orderId,
          orderItemId: sale.orderItemId,
          invoiceId: sale.invoiceId,
          invoiceItemId: sale.invoiceItemId,
          qty: -Number(sale.qty),
          unitBasisQty: -Number(sale.unitBasisQty),
          netSales: -Number(sale.netSales),
          categoryTax: -Number(sale.categoryTax),
          soldAt: sale.soldAt,
          periodBucket: sale.periodBucket,
          createdAt: t0,
        },
      });
      await prisma.regulatedSalesLedger.create({
        data: {
          tenantId: s.tenantId,
          trackedCategoryId: sale.trackedCategoryId,
          trackedSubcategoryId: sale.trackedSubcategoryId,
          entryType: "SALE",
          orderId: sale.orderId,
          orderItemId: sale.orderItemId,
          invoiceId: sale.invoiceId,
          invoiceItemId: sale.invoiceItemId,
          qty: Number(sale.qty),
          unitBasisQty: 120,
          netSales: Number(sale.netSales),
          categoryTax: Number(sale.categoryTax),
          soldAt: sale.soldAt,
          periodBucket: sale.periodBucket,
          createdAt: new Date(t0.getTime() + 1000),
        },
      });
    }

    it("a credit of 5 units after a same-key repack books -60 pieces, not the blend (-32.5)", async () => {
      const s = await seedSale("cr");
      await repack(s);
      const cn = await bookCredit(s, 50, 5, 5, "cr");
      const rows = (await allRows(s)).filter((r) => r.creditNoteId === cn.id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].qty)).toBe(-5);
      expect(Number(rows[0].unitBasisQty)).toBe(-60);
    });

    it("a LINE_UNIT return of 5 after the same repack books -60 pieces, never the offset sale's 1:1 ratio", async () => {
      const s = await seedSale("rt");
      await repack(s);
      const ret = await bookReturn(s, 5, "rt");
      const rows = (await allRows(s)).filter((r) => r.returnId === ret.id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].qty)).toBe(-5);
      expect(Number(rows[0].unitBasisQty)).toBe(-60);
    });
  },
);
