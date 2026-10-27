/**
 * Row 259 (#2848 door wiring; real Postgres): OrdersService.deleteOrder hard-deletes the order's invoices, and a credit note
 * the invoice SOURCED kept a dangling `invoiceId` with no SOURCE_DELETED marker, because the loop skipped
 * `unlinkSourcedCredits`. Proved through the real method:
 *   (a) a closed (fully spent) note sourced by the order's invoice is unlinked (`invoiceId` null), keeps its amounts and status,
 *       and gets exactly one SOURCE_DELETED AuditLog row naming the deleted invoice; the invoice and the order are gone;
 *   (b) a note still carrying spendable balance REFUSES the delete 409 INVOICE_HAS_UNSPENT_CREDIT (the existing B214 contract,
 *       unchanged) and nothing moves: the order, the invoice and the note's link survive and no marker is written.
 *
 * Runs only under `npm run local:test:db`. The tenant is a throwaway `qa-r259d-<run>` slug approved by `assertTestTenant`.
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
  "Row 259: deleteOrder unlinks the credit notes its invoice sourced (real Postgres)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let tenantId = "";
    let userId = "";
    let customerId = "";
    let seq = 0;
    const slug = assertTestTenant(`qa-r259d-${RUN}`, "order-delete-credit-unlink.db.spec.ts");

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
      // deleteOrder also previews the credit release and calls the commission engine (stubbed: this tenant has no
      // wallet credit applied to the order and no sales agents).
      orders.creditNotes = { ...orders.creditNotes, previewOrderCreditRelease: async () => [] };
      orders.commissionEngine = { removeInvoiceCommission: async () => undefined };
      const tenant = await prisma.tenant.create({ data: { slug, name: `r259d ${slug}` } });
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
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } }).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      await prisma?.$disconnect();
    });

    /** A DELIVERED order with one unpaid SENT invoice that sourced one credit note (amount 40, `used` of it spent). */
    async function seed(label: string, used: number) {
      seq += 1;
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId,
          orderNumber: `ORD-R259D-${RUN}-${seq}`,
          subtotal: 100,
          tax: 0,
          total: 100,
          status: "DELIVERED",
        } as any,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          orderId: order.id,
          invoiceNumber: `INV-R259D-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
        },
      });
      const note = await prisma.creditNote.create({
        data: {
          tenantId,
          customerId,
          creditNoteNumber: `CN-R259D-${RUN}-${seq}-${label}`,
          amount: 40,
          amountUsed: used,
          status: used >= 40 ? "APPLIED" : "ISSUED",
          invoiceId: invoice.id,
        } as any,
      });
      return { order, invoice, note };
    }

    it("(a) a spent note sourced by the order's invoice is unlinked and marked SOURCE_DELETED; the order and invoice are gone", async () => {
      const s = await seed("closed", 40);

      await tenantCtx.run(tenantId, () => orders.deleteOrder(s.order.id, operator()));

      expect(await prisma.order.findUnique({ where: { id: s.order.id } })).toBeNull();
      expect(await prisma.invoice.findUnique({ where: { id: s.invoice.id } })).toBeNull();
      const note = await prisma.creditNote.findUnique({ where: { id: s.note.id } });
      expect(note).not.toBeNull();
      expect(note!.invoiceId).toBeNull();
      expect(Number(note!.amount)).toBe(40);
      expect(Number(note!.amountUsed)).toBe(40);
      expect(note!.status).toBe("APPLIED");
      const marks = await prisma.auditLog.findMany({
        where: {
          tenantId,
          entityType: "CreditNote",
          entityId: s.note.id,
          action: "SOURCE_DELETED",
        },
      });
      expect(marks).toHaveLength(1);
      expect(marks[0].meta).toMatchObject({
        invoiceId: s.invoice.id,
        invoiceNumber: s.invoice.invoiceNumber,
      });
    }, 120_000);

    it("(b) a note with spendable balance refuses the delete 409 INVOICE_HAS_UNSPENT_CREDIT and nothing moves", async () => {
      const s = await seed("open", 10);

      const err: any = await tenantCtx
        .run(tenantId, () => orders.deleteOrder(s.order.id, operator()))
        .catch((e: unknown) => e);

      expect(err?.getResponse?.()).toMatchObject({ code: "INVOICE_HAS_UNSPENT_CREDIT" });
      expect(await prisma.order.findUnique({ where: { id: s.order.id } })).not.toBeNull();
      expect(await prisma.invoice.findUnique({ where: { id: s.invoice.id } })).not.toBeNull();
      expect((await prisma.creditNote.findUnique({ where: { id: s.note.id } }))!.invoiceId).toBe(
        s.invoice.id,
      );
      expect(
        await prisma.auditLog.count({
          where: { tenantId, entityId: s.note.id, action: "SOURCE_DELETED" },
        }),
      ).toBe(0);
    }, 120_000);
  },
);
