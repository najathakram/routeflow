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
    let driverUserId = "";
    let driverId = "";
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
          findOpenOrderDraft: async () => null,
          releaseWalletPaymentsInTx: async () => undefined,
          voidInvoiceInTx: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        creditNotes: {
          settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
          previewOrderCreditRelease: async () => [],
          releaseOrderCreditsInTx: async () => undefined,
        },
        notifications: {
          sendToCustomer: jest.fn().mockResolvedValue(undefined),
          sendToUser: jest.fn().mockResolvedValue(1),
        },
        messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        oversellReader: { read: async () => false },
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
      driverUserId = (
        await raw.user.create({
          data: {
            email: `dr-${run}@example.test`,
            username: `dr-${run}`,
            role: "DRIVER",
            tenantId,
          },
        })
      ).id;
      userIds.push(driverUserId);
      driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
    }, 120_000);

    afterEach(() => {
      delete orders.featureConfig;
    });

    afterAll(async () => {
      await raw.changeRequest.deleteMany({ where: { tenantId } });
      await raw.deliveryMutation.deleteMany({ where: { tenantId } });
      await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.routeRunStop.deleteMany({ where: { tenantId } });
      await raw.routeRun.deleteMany({ where: { tenantId } });
      await raw.routeStop.deleteMany({ where: { tenantId } });
      await raw.route.deleteMany({ where: { tenantId } });
      await raw.driver.deleteMany({ where: { tenantId } });
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

    /** The order on an IN_PROGRESS run (a stop), as the at-door apply needs; returns the open change request. */
    async function atDoor(orderId: string, lineId: string, productId: string, customerId: string) {
      const route = await raw.route.create({
        data: { name: `r-${run}-${orderIds.length}`, tenantId } as any,
      });
      const routeStop = await raw.routeStop.create({
        data: { tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
      });
      const rr = await raw.routeRun.create({
        data: {
          tenantId,
          routeId: route.id,
          scheduledDate: new Date("2026-10-12T00:00:00.000Z"),
          status: "IN_PROGRESS" as any,
          driverId,
        },
      });
      const stop = await raw.routeRunStop.create({
        data: {
          tenantId,
          routeRunId: rr.id,
          routeStopId: routeStop.id,
          stopNumber: 1,
          status: "PENDING" as any,
        } as any,
      });
      await raw.order.update({
        where: { id: orderId },
        data: { routeRunId: rr.id, routeRunStopId: stop.id },
      });
      return raw.changeRequest.create({
        data: {
          tenantId,
          orderId,
          productId,
          orderItemId: lineId,
          routeRunStopId: stop.id,
          type: "CHANGE_QTY" as any,
          requestedByRole: "DRIVER",
          payload: { orderItemId: lineId, newQty: 3 },
        } as any,
      });
    }
    const driver = (): JwtPayload =>
      ({
        sub: driverUserId,
        username: `dr-${run}`,
        role: "DRIVER",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    it("case 15: the at-door change-request apply on a PAID order is 400 with the door copy; the request stays open, nothing written", async () => {
      const { o, lines, products } = await pendingOrder({ status: "PAID", paid: 20 });
      const cr = await atDoor(o.id, lines[0].id, products[0], o.customerId);
      const before = await snapshot(o.id);
      await expect(
        tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver())),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: CODE,
          message: "This order is already paid. The office can add these items on a new order.",
        },
      });
      expect(await snapshot(o.id)).toEqual(before);
      expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe(
        "PENDING",
      );
    }, 60_000);

    // Cases 16-17 pin `findActiveOrder`, the one search the buyer's placement (buyer.controller `forMerge`) and the staff create's
    // merge offer both run; the controllers themselves are not driven here.
    it("cases 16-17: a customer's PAID order is not a merge target (buyer's forMerge search and staff's offer find none)", async () => {
      const { o } = await pendingOrder({ status: "PAID", paid: 20 });
      const find = (opts?: any) =>
        tenantCtx.run(tenantId, () => orders.findActiveOrder(o.customerId, opts));
      expect(await find({ forMerge: true })).toBeNull();
      expect(await find()).toBeNull();
    }, 60_000);

    it("case 16b: PARTIAL, WRITTEN_OFF, a PARTIAL deposit mirror and a SENT invoice with a live payment are not merge targets either", async () => {
      for (const o of [
        await pendingOrder({ status: "PARTIAL", paid: 10 }),
        await pendingOrder({ status: "WRITTEN_OFF" }),
        await pendingOrder({ status: "PARTIAL", paid: 10, deposit: true }),
        await pendingOrder({ status: "SENT", paid: 10 }),
      ]) {
        const found = await tenantCtx.run(tenantId, () =>
          orders.findActiveOrder(o.o.customerId, { forMerge: true }),
        );
        expect(found).toBeNull();
      }
    }, 60_000);

    it("case 18 (guard): a PENDING order with a SENT invoice and no payment is still a merge target", async () => {
      const { o } = await pendingOrder({ status: "SENT" });
      const found = await tenantCtx.run(tenantId, () =>
        orders.findActiveOrder(o.customerId, { forMerge: true }),
      );
      expect(found?.id).toBe(o.id);
    }, 60_000);

    it("a VOID (bounced) payment on a SENT invoice does not block the edit (B314 kept)", async () => {
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
