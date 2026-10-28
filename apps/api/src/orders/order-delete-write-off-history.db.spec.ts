/**
 * SA-1050 A-1 / G-W3 (real Postgres): `OrdersService.deleteOrder` hard-deletes the order's invoices through the ONE
 * order-side delete, `deleteOrderInvoice`. Once an invoice carries a write-off event the FK is RESTRICT, so the delete
 * would die as a raw P2003 (500); a written-off invoice's bad-debt history is a past period's ledger, so the delete is
 * REFUSED instead: 409 INVOICE_HAS_WRITE_OFF_HISTORY, nothing moves.
 *
 * Observed shape (G-W3): staff may delete an order in ANY status (`deleteOrder` only gates non-staff on DRAFT, PENDING,
 * CANCELLED), and a written-off invoice with no cash payment does not block it (`cancelImpact` counts payments only), so
 * an order of every status below can hold a written-off invoice and be deleted today.
 *
 * Events are seeded directly: the writer lands in a later commit of the same PR, and this spec proves the delete
 * door, not the writer.
 *
 * Runs only under `npm run local:test:db`. The tenant is a throwaway `qa-woh3-<run>` slug approved by `assertTestTenant`.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { buildDbOrdersService } from "../common/testing/orders-service-db-harness";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "SA-1050 G-W3: deleteOrder refuses a written-off invoice's history (real Postgres)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let tenantId = "";
    let userId = "";
    let customerId = "";
    let seq = 0;
    const slug = assertTestTenant(`qa-woh3-${RUN}`, "order-delete-write-off-history.db.spec.ts");

    const operator = (): JwtPayload =>
      ({
        sub: userId,
        username: `op-${RUN}`,
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      orders = buildDbOrdersService(prisma, tenantCtx);
      orders.creditNotes = { ...orders.creditNotes, previewOrderCreditRelease: async () => [] };
      orders.commissionEngine = { removeInvoiceCommission: async () => undefined };
      const tenant = await prisma.tenant.create({ data: { slug, name: `woh3 ${slug}` } });
      tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
      });
      userId = user.id;
      const customer = await prisma.customer.create({
        data: { userId, businessName: `c ${slug}`, contactName: `c ${slug}`, tenantId },
      });
      customerId = customer.id;
    });

    afterAll(async () => {
      const swallow = () => undefined;
      const where = { where: { tenantId } };
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.invoiceWriteOffEvent.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } }).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      await prisma?.$disconnect();
    });

    /** An order of `status` with one unpaid WRITTEN_OFF invoice; `withEvent` adds the one write-off event. */
    async function seed(status: string, withEvent: boolean) {
      seq += 1;
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId,
          orderNumber: `ORD-WOH3-${RUN}-${seq}`,
          subtotal: 100,
          tax: 0,
          total: 100,
          status,
        } as any,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          orderId: order.id,
          invoiceNumber: `INV-WOH3-${RUN}-${seq}`,
          status: "WRITTEN_OFF",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          writeOffReason: "uncollectable",
          writtenOffAt: new Date(),
        },
      });
      if (withEvent) {
        await prisma.invoiceWriteOffEvent.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            kind: "WRITE_OFF",
            amount: 100,
            preTax: 100,
            at: new Date(),
            byId: userId,
            reason: "uncollectable",
          },
        });
      }
      return { order, invoice };
    }

    const eventsOf = (invoiceId: string) =>
      prisma.invoiceWriteOffEvent.count({ where: { invoiceId } });

    it.each(["DRAFT", "PENDING", "CANCELLED", "DELIVERED"])(
      "a %s order holding a written-off invoice WITH history: 409 INVOICE_HAS_WRITE_OFF_HISTORY, nothing deleted",
      async (status) => {
        const s = await seed(status, true);

        const err: any = await tenantCtx
          .run(tenantId, () => orders.deleteOrder(s.order.id, operator()))
          .catch((e: unknown) => e);

        expect(err?.code).not.toBe("P2003"); // head: the RESTRICT FK surfaces raw (500)
        expect(err?.getStatus?.()).toBe(409);
        expect(err.getResponse()).toMatchObject({ code: "INVOICE_HAS_WRITE_OFF_HISTORY" });
        expect(await prisma.order.findUnique({ where: { id: s.order.id } })).not.toBeNull();
        expect(await prisma.invoice.findUnique({ where: { id: s.invoice.id } })).not.toBeNull();
        expect(await eventsOf(s.invoice.id)).toBe(1);
      },
      120_000,
    );

    it("control: a legacy written-off invoice with NO event still deletes with its order (unchanged)", async () => {
      const s = await seed("DELIVERED", false);

      await tenantCtx.run(tenantId, () => orders.deleteOrder(s.order.id, operator()));

      expect(await prisma.order.findUnique({ where: { id: s.order.id } })).toBeNull();
      expect(await prisma.invoice.findUnique({ where: { id: s.invoice.id } })).toBeNull();
    }, 120_000);
  },
);
