/**
 * Live production regression (B661/B671 fix round 2) — real-Postgres proof that
 * `ReturnsService.receive()`'s STANDARD return path reverses a box-unaware regulated line
 * correctly through the REAL caller, not a hand-built `returnedByProduct` map.
 *
 * `regulated-ledger.service.spec.ts:284-315` already covered `reverseReturnEntries` with a
 * box-unaware line — but its fixture passed `returnedByProduct: new Map([["p1", 12]])` /
 * `[["p1", 60]]`, i.e. PIECES. The real standard caller (`returns.service.ts` `receive()`)
 * sums raw `ReturnItem.qty`, which mirrors `OrderItem.qty` — the LINE's OWN unit (boxes for a
 * box-unaware line), never pieces (`returns-pieces.util.ts`'s `standardReturnPieces` is an
 * identity conversion). That mocked fixture encoded exactly the assumption the real caller
 * violates, so the existing suite stayed green over a broken seam. This file drives the SAME
 * scenario through the real `receive()`, proving the fix at the actual caller boundary.
 *
 * Worked case (matches the live defect exactly): a box-unaware sale of 5 boxes at pack 12,
 * $50 net, $10 category tax. SALE books `qty 5, unitBasisQty 60, netSales 50, categoryTax 10`.
 * Fully returned: pre-fix, `closesRow = 5 >= 60` is false and `frac = 5/60`, booking roughly
 * `qty -0.417, unitBasisQty -5, netSales -4.17, categoryTax -0.83` — about 8% of the sale.
 * Post-fix (returnedUnit: "LINE_UNIT" selects `qty`/`remQtyByLine` as the native axis): books
 * the full `qty -5, unitBasisQty -60, netSales -50, categoryTax -10`.
 *
 * WHY THE DB LANE: the seam this bug lived in is EXACTLY "does the real caller's own qty
 * survive into the ledger call unchanged" — a mocked ReturnsService (or a hand-built
 * `returnedByProduct` map passed straight to `reverseReturnEntries`) can't prove that; only a
 * real `create()` -> `approve()` -> `receive()` round-trip through real Postgres can.
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 *
 * SAFETY: a throwaway `qa-retaxis-<run>` tenant (`assertTestTenant`); `afterAll` deletes
 * exactly the rows this run created, in FK order.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ReturnsService } from "./returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "Live regression — ReturnsService.receive() reverses a box-unaware line correctly (real Postgres)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let svc: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-retaxis-${run}`, "return-reversal-unit-axis.db.spec.ts");
    let tenantId = "";
    let categoryId = "";
    const orderIds: string[] = [];
    const invoiceIds: string[] = [];
    const productIds: string[] = [];

    interface Fx {
      orderId: string;
      orderItemId: string;
      invoiceItemId: string;
      customerId: string;
      userId: string;
      productId: string;
    }

    /** A box-unaware regulated sale: 5 boxes at pack 12, $50 net, $10 category tax — matches
     *  the live defect's worked case exactly. Writes the OrderItem/InvoiceItem AND the
     *  RegulatedSalesLedger SALE row directly (the fixed shape `writeSaleEntries` itself would
     *  produce), so this test isolates `receive()`'s reversal call, not invoice creation. */
    async function seedBoxUnawareSale(tag: string): Promise<Fx> {
      const user = await raw.user.create({
        data: {
          email: `${tag}-${run}@example.test`,
          username: `${tag}-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await raw.customer.create({
        data: { userId: user.id, businessName: `${tag} co`, contactName: `${tag} co`, tenantId },
      });
      const product = await raw.product.create({
        data: {
          name: `${tag} product`,
          unit: "box",
          pricePerUnit: "10.00",
          unitsPerBox: 12,
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      productIds.push(product.id);
      const order = await raw.order.create({
        data: {
          customerId: customer.id,
          status: "DELIVERED",
          subtotal: "50.00",
          total: "50.00",
          tenantId,
        },
      });
      orderIds.push(order.id);
      const orderItem = await raw.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          status: "DELIVERED",
          // Box-unaware: qty is the line's own unit (5 boxes), no boxes/pieces split, no
          // unitLabel — regulatedUnitBasis's branch 4 (packAtSale) is what expands it to 60.
          qty: 5,
          unitPrice: "10.00",
          subtotal: "50.00",
          categoryTaxAmount: "10.00",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-AXIS-${run}-${tag}`,
          customerId: customer.id,
          orderId: order.id,
          status: "SENT",
          subtotal: "50.00",
          taxAmount: "10.00",
          total: "60.00",
          tenantId,
        },
      });
      invoiceIds.push(invoice.id);
      const invoiceItem = await raw.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          description: `${tag} product`,
          productId: product.id,
          orderItemId: orderItem.id,
          qty: 5,
          unitPrice: "10.00",
          subtotal: "50.00",
          categoryTaxAmount: "10.00",
          trackedCategoryId: categoryId,
          tenantId,
        },
      });
      // The exact SALE row shape writeSaleEntries produces (regulatedUnitBasis's box-unaware
      // branch: unitBasisQty = qty * packAtSale = 5 * 12 = 60).
      await raw.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          entryType: "SALE",
          orderId: order.id,
          orderItemId: orderItem.id,
          invoiceId: invoice.id,
          invoiceItemId: invoiceItem.id,
          qty: 5,
          unitBasisQty: 60,
          netSales: 50,
          categoryTax: 10,
          soldAt: new Date(),
          periodBucket: new Date().toISOString().slice(0, 7),
        },
      });
      return {
        orderId: order.id,
        orderItemId: orderItem.id,
        invoiceItemId: invoiceItem.id,
        customerId: customer.id,
        userId: user.id,
        productId: product.id,
      };
    }

    async function receiveFullReturn(f: Fx, qty: number) {
      return tenantCtx.run(tenantId, async () => {
        const created = await svc.create(
          {
            orderId: f.orderId,
            reason: "EXCESS_ORDER",
            items: [{ productId: f.productId, qty }],
          },
          f.userId,
          "CUSTOMER",
        );
        await svc.approve(created.id);
        return svc.receive(created.id, f.userId, { restock: false });
      });
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      // `Object.create` bypasses Nest DI (mirrors returns-idempotency.db.spec.ts) — the
      // ledger is a REAL RegulatedLedgerService sharing this same connected PrismaService, so
      // it runs inside receive()'s own transaction, not a mock that could hide the seam.
      svc = Object.assign(Object.create(ReturnsService.prototype), {
        prisma,
        gateway: { emitReturnCreated: jest.fn(), emitOrderStatusChanged: jest.fn() },
        ledger: new RegulatedLedgerService(prisma),
        creditNotes: {},
        numbering: new NumberingService(prisma),
        idempotency: undefined,
        logger: new Logger(ReturnsService.name),
      });

      tenantId = (await raw.tenant.create({ data: { slug, name: `Ret Axis ${slug}` } })).id;
      categoryId = (
        await raw.trackedCategory.create({
          data: { name: "Tobacco", taxType: "NONE", tenantId },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      for (const orderId of orderIds) {
        await raw.returnItem.deleteMany({ where: { return: { orderId } } });
        await raw.return.deleteMany({ where: { orderId } });
      }
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

    it("a FULL return (5 of 5 boxes) through the real receive() reverses the WHOLE sale, not ~8% of it", async () => {
      const f = await seedBoxUnawareSale("full");
      await receiveFullReturn(f, 5);

      const reversal = await raw.regulatedSalesLedger.findFirst({
        where: { orderItemId: f.orderItemId, entryType: "REVERSAL" },
      });
      expect(reversal).not.toBeNull();
      expect(Number(reversal!.qty)).toBe(-5); // NOT -0.417
      expect(Number(reversal!.unitBasisQty)).toBe(-60); // NOT -5
      expect(Number(reversal!.netSales)).toBe(-50); // NOT -4.17
      expect(Number(reversal!.categoryTax)).toBe(-10); // NOT -0.83

      // The net across SALE + REVERSAL is exactly 0 pieces — the tax filing sees nothing left.
      const rows = await raw.regulatedSalesLedger.findMany({
        where: { orderItemId: f.orderItemId },
      });
      const netUnitBasis = rows.reduce((s, r) => s + Number(r.unitBasisQty), 0);
      expect(netUnitBasis).toBe(0);
    }, 30_000);

    it("a PARTIAL return (2 of 5 boxes) books proportionally on BOTH axes — qty -2, unitBasisQty -24", async () => {
      const f = await seedBoxUnawareSale("partial");
      await receiveFullReturn(f, 2);

      const reversal = await raw.regulatedSalesLedger.findFirst({
        where: { orderItemId: f.orderItemId, entryType: "REVERSAL" },
      });
      expect(reversal).not.toBeNull();
      expect(Number(reversal!.qty)).toBe(-2);
      expect(Number(reversal!.unitBasisQty)).toBe(-24); // 2/5 of 60, NOT -2
      expect(Number(reversal!.netSales)).toBe(-20); // 2/5 of $50
      expect(Number(reversal!.categoryTax)).toBe(-4); // 2/5 of $10
    }, 30_000);
  },
);
