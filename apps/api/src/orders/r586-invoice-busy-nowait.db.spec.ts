/**
 * Row 586 (SA-833) on REAL Postgres, two connections: the order edit's invoice revert takes the linked Invoice row
 * NOWAIT inside the edit transaction. While another transaction holds that row, the edit is a retryable 409
 * (code CONCURRENT_UPDATE, reason INVOICE_BUSY) and NOTHING is written (order header, lines and the SENT invoice are identical afterwards).
 * Once the holder lets go, the same edit succeeds and the invoice really reverts to DRAFT.
 *
 * The revert is the REAL `InvoicesService.revertLinkedInvoicesForOrderEdit` (its real `lockRowsNoWait`), bound to
 * the real Prisma client; only the unrelated collaborators are stubbed, as in b1234-delivered-line-lock.db.spec.ts.
 * Collected only by `jest.db.config.js`. Throwaway `qa-r586-*` tenant.
 */
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "row 586: a contended linked invoice makes the order edit a 409 INVOICE_BUSY — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-r586-${run}`, "r586-invoice-busy-nowait.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let buyerUserId = "";
    let customerId = "";
    const productIds: string[] = [];
    const orderIds: string[] = [];
    const invoiceIds: string[] = [];

    const operator = (): JwtPayload =>
      ({
        sub: operatorUserId,
        username: `operator-${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      // The REAL revert (with its NOWAIT Invoice row lock), bound to the real Prisma service.
      const realRevert = InvoicesService.prototype.revertLinkedInvoicesForOrderEdit.bind({
        prisma,
      } as any);
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
          assertLinesSellable: async () => undefined,
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        invoicesService: {
          revertLinkedInvoicesForOrderEdit: realRevert,
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `r586 ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `o-${run}@example.test`,
            username: `o-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      buyerUserId = (
        await raw.user.create({
          data: {
            email: `b-${run}@example.test`,
            username: `b-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        })
      ).id;
      customerId = (
        await raw.customer.create({
          data: { userId: buyerUserId, businessName: "r586 co", contactName: "Tester", tenantId },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: { in: [operatorUserId, buyerUserId] } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    async function confirmedOrderWithSentInvoice() {
      const p = await raw.product.create({
        data: {
          name: `r586 cola ${run} #${productIds.length + 1}`,
          unit: "ea",
          pricePerUnit: "1.00",
          currentStock: "90",
          tenantId,
        },
      });
      productIds.push(p.id);
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "CONFIRMED",
          subtotal: "5.00",
          total: "5.00",
          lineItems: {
            create: [{ tenantId, productId: p.id, qty: 5, unitPrice: "1.00", subtotal: "5" }],
          },
        },
        include: { lineItems: true },
      });
      orderIds.push(o.id);
      const inv = await raw.invoice.create({
        data: {
          tenantId,
          customerId,
          orderId: o.id,
          invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
          status: "SENT",
          subtotal: "5.00",
          total: "5.00",
          sentAt: new Date(),
        },
      });
      invoiceIds.push(inv.id);
      return { o, line: o.lineItems[0], inv };
    }

    const snapshot = async (orderId: string) => ({
      header: await raw.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { subtotal: true, total: true, status: true, updatedAt: true },
      }),
      lines: await raw.orderItem.findMany({
        where: { orderId },
        orderBy: { id: "asc" },
        select: { id: true, qty: true, unitPrice: true, subtotal: true, deliveredQty: true },
      }),
      invoices: await raw.invoice.findMany({
        where: { orderId },
        orderBy: { id: "asc" },
        select: {
          id: true,
          status: true,
          sentAt: true,
          subtotal: true,
          total: true,
          internalNotes: true,
        },
      }),
    });

    /** A second connection holds the Invoice row (FOR UPDATE) until `release()`. */
    async function holdInvoiceRow(invoiceId: string) {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      const done = raw.$transaction(
        async (h) => {
          await h.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
      await lockedP;
      return { release, done };
    }

    const edit = (orderId: string, dto: any) =>
      tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, operator()));

    it("REG: while another transaction holds the linked invoice row, the edit is a retryable 409 (reason INVOICE_BUSY) and writes nothing", async () => {
      const { o, line, inv } = await confirmedOrderWithSentInvoice();
      const before = await snapshot(o.id);
      const holder = await holdInvoiceRow(inv.id);
      let err: any;
      try {
        err = await edit(o.id, { replaceAll: false, items: [{ id: line.id, qty: 6 }] }).catch(
          (e: unknown) => e,
        );
      } finally {
        holder.release();
        await holder.done;
      }
      expect(err?.getStatus?.()).toBe(409);
      // The real lock's contract (common/db-locks.ts lockRowsNoWait): code CONCURRENT_UPDATE, reason INVOICE_BUSY.
      expect(err?.getResponse?.()).toMatchObject({
        code: "CONCURRENT_UPDATE",
        reason: "INVOICE_BUSY",
        retryable: true,
      });
      expect(await snapshot(o.id)).toEqual(before);
    }, 60_000);

    it("retryable: once the holder lets go, the same edit applies and the SENT invoice really reverts to DRAFT", async () => {
      const { o, line, inv } = await confirmedOrderWithSentInvoice();
      await edit(o.id, { replaceAll: false, items: [{ id: line.id, qty: 6 }] });
      const after = await snapshot(o.id);
      expect(Number(after.lines[0].qty)).toBe(6);
      const reverted = after.invoices.find((i) => i.id === inv.id)!;
      expect(reverted.status).toBe("DRAFT");
      expect(reverted.sentAt).toBeNull();
    }, 60_000);
  },
);
