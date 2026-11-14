/**
 * W-871 reopened (SA-1144), real Postgres: a PRE-DELIVERY edit of an order whose invoice holds money or is closed
 * (PAID, PARTIAL, WRITTEN_OFF) must be refused with 400 ORDER_EDIT_INVOICE_HAS_PAYMENTS, nothing written. On master the
 * edit is accepted: the order shrinks (or grows) and the invoice keeps the old total (the counter lane's probe,
 * `local-assets/lead-2026-11-14/bugs/W-871-probe.md`: order 20 -> 10, invoice PAID 20).
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI), like w871-paid-sale-edits.db.spec.ts, but wires the
 * invoice revert to the REAL `revertLinkedInvoicesToDraft` (the one site SA-1144 changes), so the refusal is what the
 * production code does. `resyncOrderInvoicesForEdit` and `reconcileOrderDraftInvoice` are no-op stubs: before delivery the
 * real reconcile never restates a non-deposit PAID invoice (SA-1144 F3), so the stub hides no refusal.
 *
 * Collected only by jest.db.config.js. SAFETY: one throwaway `qa-w871b-<run>` tenant approved by `assertTestTenant`.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
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
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";
import { revertLinkedInvoicesToDraft } from "../invoices/order-edit-revert-set";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const CODE = "ORDER_EDIT_INVOICE_HAS_PAYMENTS";

describeDb(
  "W-871 reopened (SA-1144): a pre-delivery edit of a closed-money invoice, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-w871b-${run}`, "w871-paid-invoice-edit-lock.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    const userIds: string[] = [];
    const customerIds: string[] = [];
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

    async function customer() {
      const u = await raw.user.create({
        data: {
          email: `c-${customerIds.length}-${run}@example.test`,
          username: `c-${customerIds.length}-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      userIds.push(u.id);
      const c = await raw.customer.create({
        data: { userId: u.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
      });
      customerIds.push(c.id);
      return c.id;
    }

    async function product() {
      const p = await raw.product.create({
        data: {
          name: `w871b cola ${run} #${productIds.length + 1}`,
          unit: "ea",
          pricePerUnit: "10.00",
          currentStock: "90",
          tenantId,
        },
      });
      productIds.push(p.id);
      return p.id;
    }

    type InvoiceStatusName = "SENT" | "PARTIAL" | "PAID" | "WRITTEN_OFF";
    /**
     * The lane's fixture: a named customer's PENDING order of two lines of two products at 10.00 (total 20.00), one
     * invoice with `status`, and (when `paid` > 0) one CASH payment of that amount. `deposit` makes the invoice a deposit
     * mirror (the order's sole invoice); `ship` makes the order bill at shipment.
     */
    async function pendingOrder(opts: {
      status: InvoiceStatusName;
      paid?: number;
      deposit?: boolean;
      ship?: boolean;
    }) {
      const customerId = await customer();
      const [p1, p2] = [await product(), await product()];
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "20.00",
          total: "20.00",
          ...(opts.ship ? { fulfillPath: "SHIP" } : {}),
          lineItems: {
            create: [p1, p2].map((productId) => ({
              tenantId,
              productId,
              qty: 1,
              unitPrice: "10.00",
              subtotal: "10.00",
            })),
          },
        },
        include: { lineItems: { orderBy: { createdAt: "asc" } } },
      });
      orderIds.push(o.id);
      const inv = await raw.invoice.create({
        data: {
          tenantId,
          customerId,
          orderId: o.id,
          invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
          status: opts.status,
          subtotal: "20.00",
          total: "20.00",
          ...(opts.deposit ? { depositPercent: "50.00" } : {}),
          items: {
            create: o.lineItems.map((li, i) => ({
              tenantId,
              orderItemId: li.id,
              productId: [p1, p2][i],
              description: "cola",
              qty: 1,
              unitPrice: "10.00",
              subtotal: "10.00",
            })) as any,
          },
        },
      });
      invoiceIds.push(inv.id);
      if (opts.paid) {
        await raw.invoicePayment.create({
          data: {
            tenantId,
            invoiceId: inv.id,
            amount: opts.paid.toFixed(2),
            method: "CASH",
            status: "PAID",
          } as any,
        });
      }
      return { o, inv, lines: o.lineItems, products: [p1, p2] };
    }

    const snapshot = async (orderId: string) => ({
      header: await raw.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { subtotal: true, total: true, status: true },
      }),
      lines: await raw.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
      invoices: await raw.invoice.findMany({
        where: { orderId },
        orderBy: { id: "asc" },
        select: { id: true, status: true, subtotal: true, total: true },
      }),
      payments: await raw.invoicePayment.findMany({
        where: { invoice: { orderId } },
        orderBy: { id: "asc" },
        select: { id: true, amount: true, status: true },
      }),
    });
    const edit = (orderId: string, dto: any) =>
      tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, operator()));
    /** The refusal every closed-money case expects: 400 with the code, and nothing written. */
    async function expectLocked(orderId: string, dto: any) {
      const before = await snapshot(orderId);
      await expect(edit(orderId, dto)).rejects.toMatchObject({
        status: 400,
        response: { code: CODE },
      });
      expect(await snapshot(orderId)).toEqual(before);
    }

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
        // the one real piece: the revert (and its refusal) is production's own function, on the caller's db handle
        invoicesService: {
          revertLinkedInvoicesForOrderEdit: async (orderId: string, tx?: any, opts?: any) =>
            revertLinkedInvoicesToDraft(tx ?? prisma.forTenant(), orderId, opts),
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `w871b ${slug}` } })).id;
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
      userIds.push(operatorUserId);
    }, 120_000);

    afterEach(() => {
      delete orders.featureConfig;
    });

    afterAll(async () => {
      await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("case 1: replace-all of a PAID, undelivered named order to one line is 400 ORDER_EDIT_INVOICE_HAS_PAYMENTS, nothing written", async () => {
      const { o, products } = await pendingOrder({ status: "PAID", paid: 20 });
      await expectLocked(o.id, { replaceAll: true, items: [{ productId: products[0], qty: 1 }] });
    }, 60_000);

    it("case 2: a per-line CANCEL on the same order is refused the same way", async () => {
      const { o, lines } = await pendingOrder({ status: "PAID", paid: 20 });
      await expectLocked(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }] });
    }, 60_000);

    it("case 3: a quantity increase on the same order is refused the same way", async () => {
      const { o, lines } = await pendingOrder({ status: "PAID", paid: 20 });
      await expectLocked(o.id, { items: [{ id: lines[0].id, action: "UPDATE", qty: 3 }] });
    }, 60_000);

    it("case 4: a PARTIAL invoice ($10 of $20 paid): a per-line cut is refused", async () => {
      const { o, lines } = await pendingOrder({ status: "PARTIAL", paid: 10 });
      await expectLocked(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }] });
    }, 60_000);

    it("case 5: a WRITTEN_OFF invoice with no payment: a per-line cut is refused", async () => {
      const { o, lines } = await pendingOrder({ status: "WRITTEN_OFF" });
      await expectLocked(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }] });
    }, 60_000);

    it("case 6: an order that bills shipping is refused the same way (the in-transaction revert is not skipped)", async () => {
      orders.featureConfig = { getEffectiveMode: async () => "ship" };
      const { o, lines } = await pendingOrder({ status: "PAID", paid: 20, ship: true });
      await expectLocked(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }] });
    }, 60_000);

    it("case 7 (guard): the deposit mirror, sole invoice, PARTIAL (deposit paid): a quantity increase is accepted", async () => {
      const { o, lines } = await pendingOrder({ status: "PARTIAL", paid: 10, deposit: true });
      await edit(o.id, { items: [{ id: lines[0].id, action: "UPDATE", qty: 3 }] });
      const line = await raw.orderItem.findUniqueOrThrow({ where: { id: lines[0].id } });
      expect(Number(line.qty)).toBe(3);
      expect((await snapshot(o.id)).invoices[0].status).toBe("PARTIAL"); // the mirror is not reverted
    }, 60_000);

    it("case 8 (guard): the deposit mirror fully PAID: a quantity increase is refused", async () => {
      const { o, lines } = await pendingOrder({ status: "PAID", paid: 20, deposit: true });
      await expectLocked(o.id, { items: [{ id: lines[0].id, action: "UPDATE", qty: 3 }] });
    }, 60_000);

    it("case 9 (guard): a SENT invoice with no payment: a per-line cut is accepted and the invoice reverts to DRAFT", async () => {
      const { o, lines } = await pendingOrder({ status: "SENT" });
      await edit(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }] });
      const after = await snapshot(o.id);
      expect(after.lines.map((l) => l.status).sort()).toEqual(["CANCELLED", "PENDING"]);
      expect(after.invoices[0].status).toBe("DRAFT");
    }, 60_000);

    it("case 10 (guard): a SENT invoice with a live payment: a per-line cut is 400 with the existing text, now carrying the code", async () => {
      const { o, lines, inv } = await pendingOrder({ status: "SENT", paid: 10 });
      const before = await snapshot(o.id);
      await expect(
        edit(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }] }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: CODE,
          message: `This order can't be edited while invoice ${inv.invoiceNumber} has payments recorded. Void the invoice or remove its payments first.`,
        },
      });
      expect(await snapshot(o.id)).toEqual(before);
    }, 60_000);

    it("a VOID (bounced) payment on a PAID-status invoice does not by itself lock, only the invoice status does (B314 kept for SENT)", async () => {
      const { o, lines } = await pendingOrder({ status: "SENT", paid: 10 });
      await raw.invoicePayment.updateMany({
        where: { invoiceId: { in: invoiceIds.slice(-1) } },
        data: { status: "VOID" },
      });
      await edit(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }] });
      expect((await snapshot(o.id)).invoices[0].status).toBe("DRAFT");
    }, 60_000);
  },
);
