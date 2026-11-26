/**
 * SA-1506 PR-1a (SA-1536 (ac), §8.4): once a take-off or a cut of a delivered line is committed, no invoice bills those pieces,
 * so an inline return cannot restock them. A REAL OrdersService corrects the line (its REAL InvoicesService restates the
 * invoice in the same transaction), then the REAL inline quote and the REAL capture (a second order's edit carrying the return)
 * read the invoices that are left. Harness of inline-returns-never-sold.capture.a4.db.spec.ts with the routing spec's invoices.
 *
 * Test tenant only (qa-sa1506q-*); acme placeholders. Run via `npm run local:test:db`.
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
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "../returns/inline-returns-quote.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { InvoicesService } from "../invoices/invoices.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "SA-1536 (ac): an inline return cannot restock pieces a correction stopped billing",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let quoteService: InlineReturnsQuoteService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(
      `qa-sa1506q-${run}`,
      "delivered-line-correction.inline-return.db.spec.ts",
    );
    let tenantId = "";
    let adminId = "";
    const orderIds: string[] = [];
    const customerIds: string[] = [];
    const productIds: string[] = [];
    const userIds: string[] = [];
    const invoiceIds: string[] = [];
    let seq = 0;

    const principal = (role: string, sub: string): JwtPayload =>
      ({
        sub,
        username: `${role.toLowerCase()}-${run}`,
        role,
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    const admin = () => principal("TENANT_ADMIN", adminId);

    /** A customer with a delivered order of X (10 at 10.00, an office row) and Y (5), both billed on one SENT invoice. */
    async function fixture(tag: string) {
      const mk = async (name: string) => {
        const p = await raw.product.create({
          data: {
            name: `${tag} ${name} ${run} ${++seq}`,
            unit: "each",
            pricePerUnit: "10.00",
            currentStock: "1000",
            tenantId,
          },
        });
        productIds.push(p.id);
        return p.id;
      };
      const x = await mk("x");
      const y = await mk("y");
      const u = await raw.user.create({
        data: {
          email: `${tag}-${run}-${++seq}@example.test`,
          username: `${tag}-${run}-${seq}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      userIds.push(u.id);
      const c = await raw.customer.create({
        data: { userId: u.id, businessName: `${tag} Acme`, contactName: "Tester", tenantId },
      });
      customerIds.push(c.id);
      const order = await raw.order.create({
        data: {
          customerId: c.id,
          tenantId,
          status: "CONFIRMED",
          subtotal: "150.00",
          total: "150.00",
          lineItems: {
            create: [
              {
                tenantId,
                productId: x,
                qty: 10,
                deliveredQty: 10,
                unitPrice: "10.00",
                subtotal: "100.00",
              },
              {
                tenantId,
                productId: y,
                qty: 5,
                deliveredQty: 5,
                unitPrice: "10.00",
                subtotal: "50.00",
              },
            ],
          },
        },
        include: { lineItems: true },
      });
      orderIds.push(order.id);
      const lx = order.lineItems.find((l) => l.productId === x)!;
      const ly = order.lineItems.find((l) => l.productId === y)!;
      for (const [li, p, q] of [
        [lx, x, 10],
        [ly, y, 5],
      ] as const)
        await raw.deliveryMutation.create({
          data: {
            orderId: order.id,
            orderItemId: li.id,
            productId: p,
            routeRunStopId: null,
            driverId: null,
            type: "DELIVERED",
            quantityDelivered: q,
            note: "OFFICE_MARKED",
            tenantId,
          },
        });
      const inv = await raw.invoice.create({
        data: {
          tenantId,
          customerId: c.id,
          orderId: order.id,
          invoiceNumber: `INV-Q-${run}-${++seq}`,
          status: "SENT",
          subtotal: "150.00",
          total: "150.00",
          issueDate: new Date(Date.now() - 10 * 86_400_000),
          items: {
            create: [
              {
                tenantId,
                orderItemId: lx.id,
                productId: x,
                description: "x",
                qty: 10,
                unitPrice: "10.00",
                subtotal: "100.00",
              },
              {
                tenantId,
                orderItemId: ly.id,
                productId: y,
                description: "y",
                qty: 5,
                unitPrice: "10.00",
                subtotal: "50.00",
              },
            ],
          } as any,
        },
      });
      invoiceIds.push(inv.id);
      // the carrying order: an open PENDING order of the same customer, one line of Y; the return rides its edit
      const carrier = await raw.order.create({
        data: {
          customerId: c.id,
          tenantId,
          status: "PENDING",
          subtotal: "20.00",
          total: "20.00",
          lineItems: {
            create: [{ tenantId, productId: y, qty: 2, unitPrice: "10.00", subtotal: "20.00" }],
          },
        },
      });
      orderIds.push(carrier.id);
      return {
        customerId: c.id,
        x,
        y,
        orderId: order.id,
        lineX: lx.id,
        invoiceId: inv.id,
        carrierId: carrier.id,
      };
    }
    type F = Awaited<ReturnType<typeof fixture>>;

    const quote = (f: F, pieces: number) =>
      tenantCtx.run(tenantId, () =>
        quoteService.quote(
          {
            customerId: f.customerId,
            editingOrderId: f.carrierId,
            items: [{ productId: f.x, boxes: 0, pieces }],
          } as any,
          admin(),
        ),
      );
    const correct = (f: F, item: any) =>
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(f.orderId, { replaceAll: false, items: [item] }, admin()),
      );
    const capture = (f: F, pieces: number, key: string) =>
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(
          f.carrierId,
          {
            items: [{ productId: f.y, qty: 2 }],
            inlineReturn: { items: [{ productId: f.x, boxes: 0, pieces }], returnKey: key },
          },
          admin(),
        ),
      );
    const returnMovements = (f: F) =>
      raw.stockMovement.count({ where: { productId: f.x, type: "RETURN" } });

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const idempotency = new IdempotencyService();
      const numbering = new NumberingService(prisma);
      const ledger = new RegulatedLedgerService(prisma);
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      const featureConfig = { getEffectiveMode: async () => "ship" };
      quoteService = new (InlineReturnsQuoteService as any)(
        prisma,
        systemConfig,
        undefined,
        featureConfig,
      );
      const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        commissionEngine: {
          syncInvoiceCommissionSafe: async () => undefined,
          syncOrderInvoices: async () => undefined,
          removeInvoiceCommission: async () => undefined,
        },
        numbering,
        logger: new Logger(CreditNotesService.name),
      });
      const inlineSvc: any = Object.assign(Object.create(InlineReturnsService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        creditNotes,
        numbering,
        addonService: { hasAddon: async () => true },
        quoteService,
        idempotency,
      });
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      const invoices: any = Object.assign(Object.create(InvoicesService.prototype), {
        prisma,
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
        authority: { can: async () => false },
        ledger: anyMethod,
        gateway: anyMethod,
        commissionEngine: { syncInvoiceCommissionSafe: async () => undefined },
        logger: new Logger("sa1506q-invoices"),
      });
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: {
          emitOrderStatusChanged: jest.fn(),
          emitOrderCreated: jest.fn(),
          emitUrgentOrder: jest.fn(),
        },
        systemConfig,
        featureConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          assertLinesSellable: async () => undefined,
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        creditNotes,
        ledger,
        tenantCtx,
        invoicesService: invoices,
        logger: new Logger(OrdersService.name),
        inlineReturns: inlineSvc,
        oversellReader: { read: async () => false },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `SA1506Q ${slug}` } })).id;
      const op = await raw.user.create({
        data: {
          email: `q-ad-${run}@example.test`,
          username: `q-ad-${run}`,
          role: "TENANT_ADMIN",
          tenantId,
        },
      });
      userIds.push(op.id);
      adminId = op.id;
      await raw.systemConfig.create({ data: { tenantId, key: "settings.taxRate", value: "0" } });
    }, 120_000);

    afterAll(async () => {
      await raw.orderCreditNote.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.returnItem.deleteMany({ where: { return: { customerId: { in: customerIds } } } });
      await raw.return.deleteMany({ where: { customerId: { in: customerIds } } });
      await raw.creditNoteItem.deleteMany({ where: { creditNote: { tenantId } } });
      await raw.creditNote.deleteMany({ where: { tenantId } });
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.systemConfig.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("(ac) after a committed take-off the quote offers nothing from that order (never sold) and a capture writes 0 RETURN movements", async () => {
      const f = await fixture("ac-off");
      // before: the sale is on the invoice, so 3 pieces come back against it
      expect((await quote(f, 3)).chunks.map((c: any) => c.neverSold)).toEqual([false]);

      await correct(f, { id: f.lineX, action: "CANCEL", deliveredTo: 0 });
      expect(
        (
          await raw.invoiceItem.findMany({ where: { invoiceId: f.invoiceId, productId: f.x } })
        ).reduce((s, i) => s + Number(i.qty), 0),
      ).toBe(0);

      const q = await quote(f, 3);
      expect(q.chunks.map((c: any) => c.neverSold)).toEqual([true]); // wrong value: [false] (the order still offers it)
      await capture(f, 3, `ac-off-${run}`);
      expect(await returnMovements(f)).toBe(0); // wrong value: 1 (the 3 restocked a second time)
      const items = await raw.returnItem.findMany({
        where: { return: { customerId: f.customerId } },
      });
      expect(items.map((i) => i.restock)).toEqual([false]);
    }, 120_000);

    it("(ac) OBSERVE after a cut 10 to 8: what the quote offers against the new invoice qty", async () => {
      const f = await fixture("ac-cut");
      await correct(f, { id: f.lineX, qty: 8 });
      const billed = (
        await raw.invoiceItem.findMany({ where: { invoiceId: f.invoiceId, productId: f.x } })
      ).reduce((s, i) => s + Number(i.qty), 0);
      const q9 = await quote(f, 9);
      const q8 = await quote(f, 8);
      require("fs").appendFileSync(
        "C:/ClaudeCode/wt/sa1506-pr1-logs/observe.txt",
        "AC cut 10 to 8: invoice qty=" +
          billed +
          " quote(9) neverSold=" +
          JSON.stringify(q9.chunks.map((c: any) => [c.neverSold, c.qty ?? c.pieces ?? null])) +
          " quote(8) neverSold=" +
          JSON.stringify(q8.chunks.map((c: any) => [c.neverSold, c.qty ?? c.pieces ?? null])) +
          String.fromCharCode(10),
      );
      expect(billed).toBe(8);
    }, 120_000);
  },
);
