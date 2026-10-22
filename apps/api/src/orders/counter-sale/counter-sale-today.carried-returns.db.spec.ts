/**
 * B1262 / SA-838 (e) — real-Postgres pin for the batched read of carried returns in GET /orders/counter-sale/today.
 *
 * An INLINE return is filed on a CARRYING order (B) and sold per line on another (A): `Return.orderId = B`,
 * `ReturnItem.sourceOrderId = A`, and its credit note was issued against A's invoice and applied there. Neither
 * `Return.creditNoteId` nor `ReturnItem.sourceOrderId` has a Prisma relation, so only the service's one batched read by credit
 * note id finds it. Expected: A's row has `returnCredit` and `returnLines.applied` (its tenders exclude the credit); B's row, which holds
 * the return but not the goods, has `returnLines` all zero and shows its own store-credit application as an ordinary tender.
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
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { CounterSaleTodayService } from "./counter-sale-today.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const DAY = "2026-10-06";
const NOW = new Date("2026-10-07T15:00:00.000Z");
const AT = new Date("2026-10-06T18:00:00.000Z");

describeDb(
  "B1262 — carried INLINE returns on GET /orders/counter-sale/today (real Postgres)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let service: CounterSaleTodayService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(
      `qa-cs-carried-${run}`,
      "counter-sale-today.carried-returns.db.spec.ts",
    );
    let tenantId = "";
    let userId = "";
    let customerId = "";
    let productId = "";
    const ids = { orderA: "", orderB: "", invA: "", invB: "", cnOwn: "", cnOther: "", ret: "" };

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      service = new CounterSaleTodayService(prisma);
      tenantId = (await raw.tenant.create({ data: { slug, name: `Carried ${slug}` } })).id;
      await raw.tenantConfig.create({ data: { tenantId, timezone: "America/New_York" } });
      const user = await raw.user.create({
        data: {
          email: `c-${run}@example.test`,
          username: `c-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
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
            pricePerUnit: 5,
            currentStock: 0,
          } as never,
        })
      ).id;

      const sale = async (tag: "A" | "B") => {
        const order = await raw.order.create({
          data: {
            customerId,
            tenantId,
            counterSale: true,
            status: "DELIVERED" as never,
            orderNumber: `CR${run}-${tag}`,
            total: 12.5,
            createdAt: AT,
          },
        });
        const invoice = await raw.invoice.create({
          data: {
            invoiceNumber: `INV-${run}-${tag}`,
            customerId,
            orderId: order.id,
            tenantId,
            status: "PAID" as never,
            subtotal: 12.5,
            total: 12.5,
          },
        });
        return { order, invoice };
      };
      const a = await sale("A");
      const b = await sale("B");
      ids.orderA = a.order.id;
      ids.orderB = b.order.id;
      ids.invA = a.invoice.id;
      ids.invB = b.invoice.id;

      const note = (tag: string, invoiceId: string) =>
        raw.creditNote.create({
          data: {
            creditNoteNumber: `CN-${run}-${tag}`,
            customerId,
            tenantId,
            invoiceId,
            amount: 5.5,
            amountUsed: 5.5,
          },
        });
      ids.cnOwn = (await note("own", ids.invA)).id; // made by the INLINE return, issued against A's invoice
      ids.cnOther = (await note("other", ids.invB)).id; // an unrelated store credit B's customer used

      // A: $7.00 cash + the credit its own (carried) return made
      await raw.invoicePayment.createMany({
        data: [
          {
            invoiceId: ids.invA,
            tenantId,
            paidAt: AT,
            amount: 7,
            method: "CASH" as never,
            status: "PAID" as never,
          },
          {
            invoiceId: ids.invA,
            tenantId,
            paidAt: AT,
            amount: 5.5,
            method: "CREDIT_NOTE" as never,
            status: "PAID" as never,
            creditNoteId: ids.cnOwn,
          },
          {
            invoiceId: ids.invB,
            tenantId,
            paidAt: AT,
            amount: 7,
            method: "CASH" as never,
            status: "PAID" as never,
          },
          {
            invoiceId: ids.invB,
            tenantId,
            paidAt: AT,
            amount: 5.5,
            method: "CREDIT_NOTE" as never,
            status: "PAID" as never,
            creditNoteId: ids.cnOther,
          },
        ],
      });

      // the INLINE return: filed on B (the carrier), its one item sold on A, priced per item
      const ret = await raw.return.create({
        data: {
          returnNumber: `R${run}-1`,
          orderId: ids.orderB,
          customerId,
          tenantId,
          reason: "DAMAGED",
          status: "PROCESSED" as never,
          kind: "INLINE" as never,
          refundMethod: "CREDIT_NOTE",
          creditNoteId: ids.cnOwn,
          creditSubtotal: 5,
          creditTax: 0.5,
          creditCategoryTax: 0,
          createdAt: AT,
        },
      });
      ids.ret = ret.id;
      await raw.returnItem.create({
        data: {
          returnId: ret.id,
          productId,
          tenantId,
          qty: 1,
          sourceOrderId: ids.orderA,
          subtotal: 5,
          taxAmount: 0.5,
          categoryTax: 0,
        },
      });
    }, 120_000);

    afterAll(async () => {
      await raw.returnItem.deleteMany({ where: { returnId: ids.ret } });
      await raw.return.deleteMany({ where: { id: ids.ret } });
      await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: [ids.invA, ids.invB] } } });
      await raw.creditNote.deleteMany({ where: { id: { in: [ids.cnOwn, ids.cnOther] } } });
      await raw.invoice.deleteMany({ where: { id: { in: [ids.invA, ids.invB] } } });
      await raw.order.deleteMany({ where: { id: { in: [ids.orderA, ids.orderB] } } });
      await raw.product.deleteMany({ where: { id: productId } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: userId } });
      await raw.tenantConfig.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("(e) sale A: its INLINE return carried on B is A's returnCredit and returnLines.applied; B shows its store credit as a tender", async () => {
      const res = await tenantCtx.run(tenantId, () =>
        service.today({ day: DAY, page: 1, limit: 100 } as never, NOW),
      );
      const rowA = res.data.find((r) => r.orderId === ids.orderA)!;
      const rowB = res.data.find((r) => r.orderId === ids.orderB)!;

      expect(rowA.paid).toBe(12.5);
      expect(rowA.tenderPaid).toBe(7);
      expect(rowA.returnCredit).toBe(5.5);
      expect(rowA.tenderMethods).toEqual([{ method: "CASH", amount: 7 }]);
      expect(rowA.returnLines).toEqual({ applied: 5.5, refunded: 0, kept: 0, pending: false });

      // B holds the return (its `returned` counts it) but not the goods: no Returned line, the credit it used is a tender
      expect(rowB.returned.amount).toBe(5.5);
      expect(rowB.returnLines).toEqual({ applied: 0, refunded: 0, kept: 0, pending: false });
      expect(rowB.returnCredit).toBe(0);
      expect(rowB.tenderPaid).toBe(12.5);
      expect(rowB.tenderMethods).toEqual([
        { method: "CASH", amount: 7 },
        { method: "STORE_CREDIT", amount: 5.5 },
      ]);
    });
  },
);
