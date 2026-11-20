/**
 * W-871 reopened (SA-1144), real Postgres: a PRE-DELIVERY edit of an order whose invoice holds money or is closed
 * (PAID, PARTIAL, WRITTEN_OFF) must be refused with 400 ORDER_EDIT_INVOICE_HAS_PAYMENTS, nothing written. On master the
 * edit is accepted: the order shrinks (or grows) and the invoice keeps the old total (the counter lane's probe,
 * `local-assets/lead-2026-11-14/bugs/W-871-probe.md`: order 20 -> 10, invoice PAID 20).
 *
 * Builds a REAL OrdersService and a REAL InvoicesService via `Object.create` (no Nest DI; the harness of
 * counter-sale-void.db.spec.ts), so the revert, its refusal, the resync and the reconcile are all production's own: no stubs
 * on the invoice side (SA-1144 fix round, item 5).
 *
 * Collected only by jest.db.config.js. SAFETY: one throwaway `qa-w871b-<run>` tenant approved by `assertTestTenant`.
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
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { InvoicesService } from "../invoices/invoices.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { BuyerController } from "../buyer/buyer.controller";

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
    let afterFirstInvoiceRead: null | (() => Promise<void>) = null;
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
    const creditNoteIds: string[] = [];
    /** SA-1156 E5r: the refusal the settle sends, as text (the pre-check runs the same predicate). */
    const SOURCE_GONE = { status: 409, code: "CREDIT_NOTE_SOURCE_GONE" };
    const SOURCE_GONE_TEXT =
      "came from a deleted invoice. Void that credit note first, then try again.";
    const DOOR_SENTENCE =
      "This order's invoice can't change at the door. The office can add these items on a new order.";

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

    type InvoiceStatusName = "SENT" | "PARTIAL" | "PAID" | "WRITTEN_OFF" | "DRAFT";
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
        logger: new Logger("w871b-invoices"),
      });
      // case 20: a hook that fires once, right after the revert's first invoice read, on the edit's own tx
      const realRevert = invoices.revertLinkedInvoicesForOrderEdit.bind(invoices);
      invoices.revertLinkedInvoicesForOrderEdit = (orderId: string, tx?: any, opts?: any) => {
        if (!tx || !afterFirstInvoiceRead) return realRevert(orderId, tx, opts);
        const fire = afterFirstInvoiceRead;
        afterFirstInvoiceRead = null;
        let fired = false;
        const wrap = (obj: any): any =>
          new Proxy(obj, {
            get(t, prop) {
              const v = Reflect.get(t, prop, t);
              if (prop === "invoice") {
                return new Proxy(v, {
                  get(it, q) {
                    const fn = Reflect.get(it, q, it);
                    if (q !== "findMany") return typeof fn === "function" ? fn.bind(it) : fn;
                    return async (...args: unknown[]) => {
                      const rows = await fn.apply(it, args);
                      if (!fired) {
                        fired = true;
                        await fire();
                      }
                      return rows;
                    };
                  },
                });
              }
              return typeof v === "function" ? v.bind(t) : v;
            },
          });
        return realRevert(orderId, wrap(tx), opts);
      };
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
        invoicesService: invoices,
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
      await raw.auditLog.deleteMany({
        where: { entityType: "CreditNote", entityId: { in: creditNoteIds } },
      });
      await raw.orderCreditNote.deleteMany({ where: { tenantId } });
      await raw.creditNote.deleteMany({ where: { tenantId } });
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
      const after = await snapshot(o.id);
      expect(after.invoices[0].status).toBe("PARTIAL"); // the mirror is not reverted
      // and the widened reconcile restated it: the mirror's total follows the new order total (no stub)
      expect(Number(after.invoices[0].total)).toBe(Number(after.header.total));
      expect(Number(after.header.total)).toBe(40);
    }, 60_000);

    it("case 8 (guard): the deposit mirror fully PAID: a quantity increase is refused", async () => {
      const { o, lines } = await pendingOrder({ status: "PAID", paid: 20, deposit: true });
      await expectLocked(o.id, { items: [{ id: lines[0].id, action: "UPDATE", qty: 3 }] });
    }, 60_000);

    it("case 9 (guard): a SENT invoice with no payment: a per-line cut is accepted and the invoice reverts to DRAFT", async () => {
      const { o, lines } = await pendingOrder({ status: "SENT" });
      await edit(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }], ackSentRevert: true }); // B1372 N2
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
    async function atDoor(
      orderId: string,
      lineId: string,
      productId: string,
      customerId: string,
      type: "CHANGE_QTY" | "REMOVE_ITEM" = "CHANGE_QTY",
    ) {
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
          type: type as any,
          requestedByRole: "DRIVER",
          payload:
            type === "CHANGE_QTY" ? { orderItemId: lineId, newQty: 3 } : { orderItemId: lineId },
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

    it("cases 15 and 22: the at-door change-request apply on a PAID order is 409 in the at-stop shape (same code, the driver's sentence); the request stays open, nothing written", async () => {
      const { o, lines, products } = await pendingOrder({ status: "PAID", paid: 20 });
      const cr = await atDoor(o.id, lines[0].id, products[0], o.customerId);
      const before = await snapshot(o.id);
      await expect(
        tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver())),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: CODE,
          message:
            "This order's invoice can't change at the door. The office can add these items on a new order.",
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

    // Writer search for case 19 (a DRAFT invoice holding a live payment): `completeWithPayment` finalizes DRAFT to SENT before it
    // applies a payment (invoices.service.ts, the at-stop path), so that writer leaves none behind. The other InvoicePayment writers
    // (import.service.ts x3, customers.service.ts:1231, credit-notes.service.ts:933, bookkeeping.service.ts:309) were NOT shown to
    // finalize first, so a DRAFT invoice with a payment is reachable by data; this case runs it as a refusal, via the shared fragment.
    it("case 19: a DRAFT invoice holding a live payment, PENDING order: a per-line cut is 400 with the code", async () => {
      const { o, lines } = await pendingOrder({ status: "SENT", paid: 10 });
      await raw.invoice.updateMany({ where: { orderId: o.id }, data: { status: "DRAFT" } });
      await expectLocked(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }] });
    }, 60_000);

    it("case 20: the exempt deposit mirror takes its final payment right after the edit's first invoice read: the edit refuses 400, nothing written", async () => {
      const { o, lines, inv } = await pendingOrder({ status: "PARTIAL", paid: 10, deposit: true });
      afterFirstInvoiceRead = async () => {
        await raw.invoicePayment.create({
          data: {
            tenantId,
            invoiceId: inv.id,
            amount: "10.00",
            method: "CASH",
            status: "PAID",
          } as any,
        });
        await raw.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
      };
      const dto = { items: [{ id: lines[0].id, action: "UPDATE", qty: 3 }] };
      await expect(edit(o.id, dto)).rejects.toMatchObject({
        status: 400,
        response: { code: CODE },
      });
      const line = await raw.orderItem.findUniqueOrThrow({ where: { id: lines[0].id } });
      expect(Number(line.qty)).toBe(1);
    }, 60_000);

    // ---- SA-1156: what the post-edit settle re-adjusts (a credit-note payment on a DRAFT) does not lock; everything else does ----
    type PayKind =
      "CASH" | "CHECK" | "ACH" | "OTHER" | "CREDIT_CARD" | "ZELLE" | "ADVANCE" | "CREDIT_NOTE";
    /** A DRAFT-invoice order (the deliver-later pending mirror) holding one payment of the given kind. */
    async function draftWith(
      kind: PayKind | null,
      p: {
        status?: "PAID" | "DRAFT" | "PENDING" | "VOID";
        noNote?: boolean;
        invoice?: InvoiceStatusName;
      } = {},
    ) {
      const made = await pendingOrder({ status: p.invoice ?? "DRAFT" });
      if (kind) {
        const cn =
          kind === "CREDIT_NOTE" && !p.noNote
            ? await raw.creditNote.create({
                data: {
                  tenantId,
                  customerId: made.o.customerId,
                  creditNoteNumber: `CN-${randomUUID().slice(0, 8)}`,
                  amount: "15.00",
                  amountUsed: "15.00",
                  status: "ISSUED",
                } as any,
              })
            : null;
        await raw.invoicePayment.create({
          data: {
            tenantId,
            invoiceId: made.inv.id,
            amount: kind === "CREDIT_NOTE" ? "15.00" : "5.00",
            method: kind,
            status: p.status ?? "PAID",
            ...(cn ? { creditNoteId: cn.id } : {}),
          } as any,
        });
      }
      return made;
    }
    const cut = (lines: Array<{ id: string }>) => ({
      items: [{ id: lines[0].id, action: "CANCEL" }],
    });

    it("E2/E3: a DRAFT mirror whose only payment is a credit note: the edit is allowed (the settle re-adjusts the credit)", async () => {
      const { o, lines } = await draftWith("CREDIT_NOTE");
      await edit(o.id, cut(lines));
      expect(
        (await raw.orderItem.findMany({ where: { orderId: o.id, status: "CANCELLED" } })).length,
      ).toBe(1);
    }, 60_000);

    it("E4: the same order, a quantity increase, is allowed", async () => {
      const { o, lines } = await draftWith("CREDIT_NOTE");
      await edit(o.id, { items: [{ id: lines[0].id, qty: 3 }] });
      expect(
        Number((await raw.orderItem.findUniqueOrThrow({ where: { id: lines[0].id } })).qty),
      ).toBe(3);
    }, 60_000);

    it.each(["CASH", "CHECK", "ACH", "OTHER", "CREDIT_CARD", "ZELLE"] as const)(
      "E6: a DRAFT invoice with %s money on it still locks the edit",
      async (kind) => {
        const { o, lines } = await draftWith(kind);
        await expectLocked(o.id, cut(lines));
      },
      60_000,
    );

    it.each([
      ["E7 unconfirmed external row", "CASH", { status: "DRAFT" }],
      ["E8 PENDING post-dated check (no writer)", "CHECK", { status: "PENDING" }],
      ["E9 ADVANCE (no writer)", "ADVANCE", {}],
      ["E12 credit-note payment with no note id (no writer)", "CREDIT_NOTE", { noNote: true }],
    ] as const)(
      "%s on a DRAFT locks the edit",
      async (_n, kind, p) => {
        const { o, lines } = await draftWith(kind, p as any);
        await expectLocked(o.id, cut(lines));
      },
      60_000,
    );

    it("E10: a credit note AND cash on one DRAFT invoice: locked (the cash)", async () => {
      const { o, lines, inv } = await draftWith("CREDIT_NOTE");
      await raw.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: inv.id,
          amount: "5.00",
          method: "CASH",
          status: "PAID",
        } as any,
      });
      await expectLocked(o.id, cut(lines));
    }, 60_000);

    it("E11 (guard): only a VOID payment on a DRAFT: allowed", async () => {
      const { o, lines } = await draftWith("CHECK", { status: "VOID" });
      await edit(o.id, cut(lines));
    }, 60_000);

    it("E13 (guard): a SENT invoice whose only payment is a credit note: still locked", async () => {
      const { o, lines } = await draftWith("CREDIT_NOTE", { invoice: "SENT" });
      await expectLocked(o.id, cut(lines));
    }, 60_000);

    it("M1/M2: a DRAFT mirror holding only a credit IS a merge target; one holding cash is not", async () => {
      const credit = await draftWith("CREDIT_NOTE");
      const cash = await draftWith("CASH");
      const find = (id: string) =>
        tenantCtx.run(tenantId, () => orders.findActiveOrder(id, { forMerge: true }));
      expect((await find(credit.o.customerId))?.id).toBe(credit.o.id);
      expect(await find(cash.o.customerId)).toBeNull();
    }, 60_000);

    it("D1-D3: a display read (no forMerge) still returns a customer's PAID open order", async () => {
      const { o } = await pendingOrder({ status: "PAID", paid: 20 });
      const found = await tenantCtx.run(tenantId, () => orders.findActiveOrder(o.customerId));
      expect(found?.id).toBe(o.id);
    }, 60_000);

    it("A1: the at-door apply on a DRAFT mirror holding only a credit goes through", async () => {
      const { o, lines, products } = await draftWith("CREDIT_NOTE");
      const cr = await atDoor(o.id, lines[0].id, products[0], o.customerId);
      await tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver()));
      expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).not.toBe(
        "PENDING",
      );
    }, 60_000);

    /** SA-1156 section 0: the door's settle runs with the REAL credit service (the edit rows above stub it). */
    async function creditDraft(opts?: {
      noteAmount?: string;
      used?: string;
      payment?: string;
      intent?: string;
    }) {
      const made = await pendingOrder({ status: "DRAFT" });
      const cn = await raw.creditNote.create({
        data: {
          tenantId,
          customerId: made.o.customerId,
          creditNoteNumber: `CN-${randomUUID().slice(0, 8)}`,
          amount: opts?.noteAmount ?? "15.00",
          amountUsed: opts?.used ?? "15.00",
          status: "ISSUED",
        } as any,
      });
      creditNoteIds.push(cn.id);
      await raw.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: made.inv.id,
          amount: opts?.payment ?? "15.00",
          method: "CREDIT_NOTE",
          status: "PAID",
          creditNoteId: cn.id,
        } as any,
      });
      await raw.orderCreditNote.create({
        data: {
          tenantId,
          orderId: made.o.id,
          creditNoteId: cn.id,
          amount: opts?.intent ?? "15.00",
        } as any,
      });
      return { ...made, cn };
    }
    async function withRealCredits<T>(fn: (real: CreditNotesService) => Promise<T>): Promise<T> {
      const real = new CreditNotesService(
        prisma,
        { emitCreditNoteCreated: jest.fn(), emitInvoiceUpdated: jest.fn() } as any,
        { get: () => undefined } as any,
        { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) } as any,
        new NumberingService(prisma),
      );
      const stubbed = orders.creditNotes;
      orders.creditNotes = real;
      try {
        return await fn(real);
      } finally {
        orders.creditNotes = stubbed;
      }
    }
    const creditState = async (invId: string, cnId: string) => ({
      paid: Number(
        (
          await raw.invoicePayment.findFirstOrThrow({
            where: { invoiceId: invId, method: "CREDIT_NOTE" },
          })
        ).amount,
      ),
      used: Number((await raw.creditNote.findUniqueOrThrow({ where: { id: cnId } })).amountUsed),
    });

    /** A1b read: the SUM of non-VOID CREDIT_NOTE payments naming the note (an apply writes a NEW row), plus the note's amountUsed. */
    const creditSum = async (invId: string, cnId: string) => ({
      paid: Number(
        (
          await raw.invoicePayment.findMany({
            where: {
              invoiceId: invId,
              method: "CREDIT_NOTE",
              creditNoteId: cnId,
              status: { not: "VOID" },
            },
          })
        ).reduce((a, p) => a + Number(p.amount), 0),
      ),
      used: Number((await raw.creditNote.findUniqueOrThrow({ where: { id: cnId } })).amountUsed),
    });
    const markSourceGone = (cnId: string) =>
      raw.auditLog.create({
        data: {
          tenantId,
          action: "SOURCE_DELETED",
          entityType: "CreditNote",
          entityId: cnId,
        } as any,
      });
    /** Everything a refusal must leave alone: the order snapshot, the credit rows, revisions, audit rows and stock. */
    const everything = async (orderId: string, products: string[]) => ({
      snap: await snapshot(orderId),
      credit: await raw.creditNote.findMany({ orderBy: { id: "asc" }, where: { tenantId } }),
      revisions: await raw.orderRevision.count({ where: { orderId } }),
      audits: await raw.auditLog.count({ where: { tenantId, entityId: orderId } }),
      stock: (
        await raw.product.findMany({ where: { id: { in: products } }, orderBy: { id: "asc" } })
      ).map((p) => Number(p.currentStock)),
    });

    it("A1/E19 (decrease): a door REMOVE_ITEM on a DRAFT holding a $15 credit settles the credit down to the new total", async () => {
      const { o, inv, lines, products, cn } = await creditDraft();
      const cr = await atDoor(o.id, lines[0].id, products[0], o.customerId, "REMOVE_ITEM");
      await withRealCredits(() =>
        tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver())),
      );
      expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).not.toBe(
        "PENDING",
      );
      expect(Number((await raw.invoice.findUniqueOrThrow({ where: { id: inv.id } })).total)).toBe(
        10,
      );
      expect(await creditState(inv.id, cn.id)).toEqual({ paid: 10, used: 10 });
    }, 60_000);

    it("A1b (increase): a door CHANGE_QTY to $40 tops the credit up to the intent: 30 paid, 30 used (no settle: 20 and 20)", async () => {
      // the fixture the creation settle leaves on a $20 DRAFT with a larger intent: note 30, used 20, one $20 payment, intent 30
      const { o, inv, lines, products, cn } = await creditDraft({
        noteAmount: "30.00",
        used: "20.00",
        payment: "20.00",
        intent: "30.00",
      });
      const cr = await atDoor(o.id, lines[0].id, products[0], o.customerId, "CHANGE_QTY");
      await withRealCredits(() =>
        tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver())),
      );
      expect(Number((await raw.invoice.findUniqueOrThrow({ where: { id: inv.id } })).total)).toBe(
        40,
      );
      expect(await creditSum(inv.id, cn.id)).toEqual({ paid: 30, used: 30 });
    }, 60_000);

    it("A1c: a settle that throws never fails the door; one ERROR is logged and the request is applied", async () => {
      const { o, lines, products } = await creditDraft();
      const cr = await atDoor(o.id, lines[0].id, products[0], o.customerId, "REMOVE_ITEM");
      const err = jest.spyOn(orders.logger, "error").mockImplementation(() => undefined);
      try {
        await withRealCredits(async (real) => {
          jest.spyOn(real, "settleOrderCreditsInTx").mockRejectedValue(new Error("settle boom"));
          const res = await tenantCtx.run(tenantId, () =>
            orders.approveChangeRequestAtStop(cr.id, driver()),
          );
          expect(res.merged).toBe(true);
        });
        expect(
          (await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status,
        ).not.toBe("PENDING");
        expect(err).toHaveBeenCalledTimes(1);
        expect(String(err.mock.calls[0][0])).toContain(o.id);
      } finally {
        err.mockRestore();
      }
    }, 60_000);

    it("E2 (numbers, real credit service): the edit shrinks the credit payment to the new total and returns the rest to the note", async () => {
      const { o, inv, lines, cn } = await creditDraft();
      await withRealCredits(() => edit(o.id, cut(lines)));
      expect(Number((await raw.invoice.findUniqueOrThrow({ where: { id: inv.id } })).total)).toBe(
        10,
      );
      expect(await creditState(inv.id, cn.id)).toEqual({ paid: 10, used: 10 });
    }, 60_000);

    it("E5r (red-first): the credit's source note is gone: the edit is refused 409 CREDIT_NOTE_SOURCE_GONE and NOTHING is written", async () => {
      const { o, lines, products, cn } = await creditDraft();
      await markSourceGone(cn.id);
      const before = await everything(o.id, products);
      const got = (await withRealCredits(() =>
        edit(o.id, cut(lines)).then(
          () => ({ status: 200, code: undefined as string | undefined, message: "" }),
          (e: any) => ({
            status: e?.status as number,
            code: e?.response?.code as string | undefined,
            message: String(e?.response?.message),
          }),
        ),
      )) as { status: number; code: string | undefined; message: string };
      expect({ status: got.status, code: got.code }).toEqual(SOURCE_GONE);
      expect(got.message).toContain(SOURCE_GONE_TEXT);
      expect(await everything(o.id, products)).toEqual(before);
    }, 60_000);

    it("E5g1 (guard): source gone, a $10 credit and the order cut to $10 (the boundary: no excess): 200, no shrink, the pre-check does not fire", async () => {
      const { o, inv, lines, cn } = await creditDraft({
        noteAmount: "10.00",
        used: "10.00",
        payment: "10.00",
        intent: "10.00",
      });
      await markSourceGone(cn.id);
      await withRealCredits(() => edit(o.id, cut(lines)));
      expect(Number((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).total)).toBe(10);
      expect(await creditState(inv.id, cn.id)).toEqual({ paid: 10, used: 10 });
    }, 60_000);

    it("E5g2 (guard): the same edit with the source present: 200, the settle shrinks the credit to $10 (as today)", async () => {
      const { o, inv, lines, cn } = await creditDraft();
      await withRealCredits(() => edit(o.id, cut(lines)));
      expect(await creditState(inv.id, cn.id)).toEqual({ paid: 10, used: 10 });
    }, 60_000);

    it("E5g3: source gone, a quantity increase (order $20 to $40) with the credit intent fully applied: 200, the invoice follows to $40 and no credit is written (15 paid, 15 used)", async () => {
      const { o, inv, lines, cn } = await creditDraft();
      await markSourceGone(cn.id);
      await withRealCredits(() => edit(o.id, { items: [{ id: lines[0].id, qty: 3 }] }));
      expect(Number((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).total)).toBe(40);
      expect(Number((await raw.invoice.findUniqueOrThrow({ where: { id: inv.id } })).total)).toBe(
        40,
      );
      expect(await creditState(inv.id, cn.id)).toEqual({ paid: 15, used: 15 });
    }, 60_000);

    it("E5d (red-first): source gone, the door lowers the order to $10: 409 ORDER_EDIT_INVOICE_HAS_PAYMENTS with the door sentence, the request stays open, nothing written", async () => {
      const { o, lines, products, cn } = await creditDraft();
      await markSourceGone(cn.id);
      const cr = await atDoor(o.id, lines[0].id, products[0], o.customerId, "REMOVE_ITEM");
      const before = await everything(o.id, products);
      const got = await withRealCredits(() =>
        tenantCtx
          .run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver()))
          .then(
            () => ({ status: 200, code: undefined as string | undefined, message: "" }),
            (e: any) => ({
              status: e?.status as number,
              code: e?.response?.code as string | undefined,
              message: String(e?.response?.message),
            }),
          ),
      );
      expect(got).toEqual({ status: 409, code: CODE, message: DOOR_SENTENCE });
      expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe(
        "PENDING",
      );
      expect(await everything(o.id, products)).toEqual(before);
    }, 60_000);

    it("E5c (guard): two invoices on the order (no single mirror): the pre-check does not fire; the edit commits, the order is $10, the base invoice stays $20, the credit stays 15 and 15 (the SA-681 partials state, as on master)", async () => {
      const { o, inv, lines, cn } = await creditDraft();
      await markSourceGone(cn.id);
      const second = await raw.invoice.create({
        data: {
          tenantId,
          customerId: o.customerId,
          orderId: o.id,
          invoiceNumber: `INV-${randomUUID().slice(0, 8)}-R1`,
          status: "DRAFT",
          subtotal: "0.00",
          total: "0.00",
        },
      });
      invoiceIds.push(second.id);
      const got = await withRealCredits(() =>
        edit(o.id, cut(lines)).then(
          () => "committed" as const,
          (e: any) => ({ status: e?.status as number, code: e?.response?.code as string }),
        ),
      );
      expect(got).toBe("committed");
      expect(Number((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).total)).toBe(10);
      expect(Number((await raw.invoice.findUniqueOrThrow({ where: { id: inv.id } })).total)).toBe(
        20,
      );
      expect(await creditState(inv.id, cn.id)).toEqual({ paid: 15, used: 15 });
      expect((await creditState(inv.id, cn.id)).paid).toBeGreaterThan(0);
    }, 60_000);

    it("A2: the door apply on a DRAFT holding cash still refuses 409 with the door sentence; the request stays open, nothing written", async () => {
      const { o, lines, products } = await draftWith("CASH");
      const cr = await atDoor(o.id, lines[0].id, products[0], o.customerId);
      const before = await snapshot(o.id);
      await expect(
        tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver())),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: CODE, message: DOOR_SENTENCE },
      });
      expect((await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe(
        "PENDING",
      );
      expect(await snapshot(o.id)).toEqual(before);
    }, 60_000);

    it("M3 (through the real buyer place): a cart beside a PAID order makes a NEW order and the PAID order is untouched", async () => {
      const { o, products } = await pendingOrder({ status: "PAID", paid: 20 });
      const before = await snapshot(o.id);
      const userId = (await raw.customer.findUniqueOrThrow({ where: { id: o.customerId } }))
        .userId as string;
      const stubs: any[] = Array.from({ length: 19 }, () => ({}));
      stubs[7] = orders;
      stubs[16] = prisma;
      const buyerCtl = new (BuyerController as any)(...stubs) as BuyerController;
      const res: any = await tenantCtx.run(tenantId, () =>
        buyerCtl.createOrder(
          { items: [{ productId: products[0], qty: 1 }] } as any,
          { tenantId, tenantSlug: slug, customerId: o.customerId, userId, role: "CUSTOMER" } as any,
        ),
      );
      orderIds.push(res.id);
      expect(res.id).not.toBe(o.id);
      expect(await snapshot(o.id)).toEqual(before);
    }, 60_000);

    it("a VOID (bounced) payment on a SENT invoice does not block the edit (B314 kept)", async () => {
      const { o, lines } = await pendingOrder({ status: "SENT", paid: 10 });
      await raw.invoicePayment.updateMany({
        where: { invoiceId: { in: invoiceIds.slice(-1) } },
        data: { status: "VOID" },
      });
      await edit(o.id, { items: [{ id: lines[0].id, action: "CANCEL" }], ackSentRevert: true }); // B1372 N2
      expect((await snapshot(o.id)).invoices[0].status).toBe("DRAFT");
    }, 60_000);
  },
);
