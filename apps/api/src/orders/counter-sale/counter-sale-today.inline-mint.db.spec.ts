/**
 * B1262 follow-up / SA-838b — real-Postgres pin: the credit note the REAL inline mint makes has no invoice, and the counter
 * reprint must still treat it as the sale's own return credit.
 *
 * The credit is made by the production path, not a fixture: `InlineReturnsService.issueCreditInTx` -> `mintStandaloneInTx`
 * (`CreditNote.invoiceId = NULL`) -> the system-owned intent -> `settleOrderCreditsInTx`, which applies it to the carrying
 * order's invoice as a PAID CREDIT_NOTE payment. Then GET /orders/counter-sale/today reads the sale:
 *   - single source: every item sold on this order -> returnCredit 3.00, no tender, returnLines.applied 3.00;
 *   - mixed source (items sold on two orders): not provably this order's own -> the credit stays the "Store credit" tender.
 *
 * NOT RUN by the authoring lane (no Postgres here): the DB lane runs it (`npm run local:test:db`, test tenants only,
 * collected only by jest.db.config.js). Placeholders only (acme).
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { NumberingService } from "../../import/numbering.service";
import { RegulatedLedgerService } from "../../regulated/regulated-ledger.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { InlineReturnsService } from "../../returns/inline-returns.service";
import { CounterSaleTodayService } from "./counter-sale-today.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const DAY = "2026-10-06";
const NOW = new Date("2026-10-07T15:00:00.000Z");
const AT = new Date("2026-10-06T18:00:00.000Z");

describeDb(
  "SA-838b — the inline-minted credit note on GET /orders/counter-sale/today (real Postgres)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let service: CounterSaleTodayService;
    let inline: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(
      `qa-cs-inlinemint-${run}`,
      "counter-sale-today.inline-mint.db.spec.ts",
    );
    let tenantId = "";
    let userId = "";
    let customerId = "";
    let productId = "";
    const orderIds: string[] = [];
    const invoiceIds: string[] = [];
    const returnIds: string[] = [];

    /** a $7.50 counter sale with its invoice (SENT, nothing paid yet) */
    async function sale(tag: string, withInvoice = true) {
      const order = await raw.order.create({
        data: {
          customerId,
          tenantId,
          counterSale: true,
          status: "DELIVERED" as never,
          orderNumber: `IM${run}-${tag}`,
          total: 7.5,
          createdAt: AT,
        },
      });
      orderIds.push(order.id);
      let invoiceId = "";
      if (withInvoice) {
        const invoice = await raw.invoice.create({
          data: {
            invoiceNumber: `INV-${run}-${tag}`,
            customerId,
            orderId: order.id,
            tenantId,
            status: "SENT" as never,
            subtotal: 7.5,
            total: 7.5,
          },
        });
        invoiceIds.push(invoice.id);
        invoiceId = invoice.id;
      }
      return { orderId: order.id, invoiceId };
    }

    /** an INLINE return captured on `carryingOrderId` (RECEIVED, no credit yet), one $3.00 item per source order */
    async function capturedReturn(tag: string, carryingOrderId: string, sourceOrderIds: string[]) {
      const ret = await raw.return.create({
        data: {
          returnNumber: `R${run}-${tag}`,
          orderId: carryingOrderId,
          customerId,
          tenantId,
          reason: "DAMAGED",
          status: "RECEIVED" as never,
          kind: "INLINE" as never,
          creditSubtotal: 3 * sourceOrderIds.length,
          creditTax: 0,
          creditCategoryTax: 0,
          createdAt: AT,
        },
      });
      returnIds.push(ret.id);
      for (const sourceOrderId of sourceOrderIds) {
        await raw.returnItem.create({
          data: {
            returnId: ret.id,
            productId,
            tenantId,
            qty: 1,
            sourceOrderId,
            subtotal: 3,
            taxAmount: 0,
            categoryTax: 0,
          },
        });
      }
      return ret;
    }

    /** the production issue step: mint (invoiceId NULL) -> intent -> settle onto the carrying order's invoice */
    const issue = (ret: { id: string; customerId: string; orderId: string }, amount: number) =>
      tenantCtx.run(tenantId, () =>
        prisma.tenantTransaction((tx: any) =>
          inline.issueCreditInTx(tx, { ...ret, returnNumber: null }, amount, tenantId, {}),
        ),
      );

    const rowOf = async (orderId: string) => {
      const res = await tenantCtx.run(tenantId, () =>
        service.today({ day: DAY, page: 1, limit: 100 } as never, NOW),
      );
      return res.data.find((r) => r.orderId === orderId)!;
    };

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      service = new CounterSaleTodayService(prisma);
      const numbering = new NumberingService(prisma);
      const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger: new RegulatedLedgerService(prisma),
        commissionEngine: { syncInvoiceCommissionSafe: async () => undefined },
        numbering,
        logger: new Logger(CreditNotesService.name),
      });
      inline = Object.assign(Object.create(InlineReturnsService.prototype), {
        prisma,
        creditNotes,
        numbering,
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `InlineMint ${slug}` } })).id;
      await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
      const user = await raw.user.create({
        data: { email: `m-${run}@example.test`, username: `m-${run}`, role: "CUSTOMER", tenantId },
      });
      userId = user.id;
      customerId = (
        await raw.customer.create({
          data: { userId, businessName: `Acme Test ${run}`, contactName: "Tester", tenantId },
        })
      ).id;
      productId = (
        await raw.product.create({
          data: {
            tenantId,
            name: `Cola 12oz Can ${run}`,
            unit: "each",
            pricePerUnit: 3,
            currentStock: 0,
          } as never,
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      await raw.orderCreditNote.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.returnItem.deleteMany({ where: { returnId: { in: returnIds } } });
      await raw.return.deleteMany({ where: { id: { in: returnIds } } });
      await raw.creditNote.deleteMany({ where: { tenantId } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.product.deleteMany({ where: { id: productId } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: userId } });
      await raw.tenantConfig.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("single source: the real mint leaves invoiceId NULL, and the reprint still splits the $3.00 credit from the tenders", async () => {
      const a = await sale("single");
      const ret = await capturedReturn("single", a.orderId, [a.orderId]);
      await issue(ret, 3);

      // the root cause, pinned on the real rows: no invoice on the note, a PAID credit-note application on the order's invoice
      const linked = await raw.return.findUniqueOrThrow({ where: { id: ret.id } });
      const note = await raw.creditNote.findUniqueOrThrow({ where: { id: linked.creditNoteId! } });
      expect(note.invoiceId).toBeNull();
      const pays = await raw.invoicePayment.findMany({ where: { invoiceId: a.invoiceId } });
      expect(pays).toHaveLength(1);
      expect(pays[0]).toMatchObject({
        method: "CREDIT_NOTE",
        status: "PAID",
        creditNoteId: note.id,
      });
      expect(Number(pays[0].amount)).toBe(3);

      const row = await rowOf(a.orderId);
      // master (wrong): returnCredit 0, tenderPaid 3, tenderMethods [{ STORE_CREDIT 3 }], returnLines.applied 0
      expect(row.paid).toBe(3);
      expect(row.tenderPaid).toBe(0);
      expect(row.returnCredit).toBe(3);
      expect(row.tenderMethods).toEqual([]);
      expect(row.returnLines).toEqual({
        applied: 3,
        refunded: 0,
        kept: 0,
        used: 0,
        pending: false,
      });
      expect(row.balanceDue).toBe(4.5);
    }, 60_000);

    it("mixed source: items sold on two orders are not provably this order's own, so the credit stays the Store credit tender", async () => {
      const m1 = await sale("mix1");
      const m2 = await sale("mix2", false);
      const ret = await capturedReturn("mix", m1.orderId, [m1.orderId, m2.orderId]);
      await issue(ret, 6);

      const row = await rowOf(m1.orderId);
      expect(row.returnCredit).toBe(0);
      expect(row.returnLines?.applied).toBe(0);
      expect(row.tenderPaid).toBe(row.paid);
      expect(row.tenderMethods).toEqual([{ method: "STORE_CREDIT", amount: row.paid }]);
      // the receipt still adds up: Balance due = Total - Paid (tenders) - Returned (0 here)
      expect(Math.round(row.balanceDue * 100)).toBe(
        Math.round((row.total - row.tenderPaid!) * 100),
      );
    }, 60_000);
  },
);
