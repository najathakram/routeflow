/**
 * SA-1097 sweep (write site 2 of 2): the AT-DOOR approved CHANGE_QTY (`OrdersService.approveChangeRequestAtStop`) resized a
 * stored box-split line with NO unitsPerBox snapshot at the product's LIVE pack, so a line sold under a 12-pack (or with no pack)
 * was re-split and re-priced at today's 24. Same class as updateOrderItems (a2-delivered-line-live-pack.db.spec.ts): the line's
 * own pack comes from `resolveStoredLinePack`, and a line none of the evidence can read is refused with
 * STORED_LINE_PACK_UNREADABLE with nothing written. Real OrdersService (Object.create harness, as b297-recompute-snapshot does),
 * real Postgres, the CR approved by a driver on an IN_PROGRESS run.
 *
 * SAFETY: one throwaway `qa-a2cr-<run>` tenant approved by `assertTestTenant`; afterAll deletes what this run created.
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
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const measure = (label: string, value: unknown) =>
  process.stdout.write(`\nMEASURE ${label} ${JSON.stringify(value)}\n`);

describeDb(
  "SA-1097 — an at-door CHANGE_QTY resizes a stored line at its own pack, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-a2cr-${run}`, "a2-at-stop-change-qty-stored-pack.db.spec.ts");
    let tenantId = "";
    let driverUserId = "";
    let driverId = "";
    let customerId = "";
    let n = 0;

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

    /** An open order with one stored box-split line (no snapshot unless given), on an IN_PROGRESS run, the product now a 24-pack. */
    async function seed(shape: {
      qty: number;
      boxes: number;
      pieces: number;
      subtotal: number;
      snapshot?: number;
    }) {
      n += 1;
      const product = await raw.product.create({
        data: {
          tenantId,
          name: `Acme cola ${run}-${n}`,
          unit: "case",
          pricePerUnit: 10,
          currentStock: 1000,
          unitsPerBox: 24,
        } as any,
      });
      const order = await raw.order.create({
        data: {
          tenantId,
          customerId,
          status: "PENDING",
          orderNumber: `ORD-A2CR-${run}-${n}`,
          subtotal: shape.subtotal,
          tax: 0,
          total: shape.subtotal,
        } as any,
      });
      const line = await raw.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: shape.qty,
          boxes: shape.boxes,
          pieces: shape.pieces,
          ...(shape.snapshot ? { unitsPerBox: shape.snapshot } : {}),
          deliveredQty: 0,
          unitPrice: 10,
          subtotal: shape.subtotal,
        } as any,
      });
      const route = await raw.route.create({ data: { name: `r-${run}-${n}`, tenantId } as any });
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
        where: { id: order.id },
        data: { routeRunId: rr.id, routeRunStopId: stop.id },
      });
      return { orderId: order.id, lineId: line.id, productId: product.id, stopId: stop.id };
    }
    type Seeded = Awaited<ReturnType<typeof seed>>;

    async function changeQty(s: Seeded, newQty: number) {
      const cr = await raw.changeRequest.create({
        data: {
          tenantId,
          orderId: s.orderId,
          productId: s.productId,
          orderItemId: s.lineId,
          routeRunStopId: s.stopId,
          type: "CHANGE_QTY" as any,
          payload: { orderItemId: s.lineId, newQty },
        } as any,
      });
      return tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver()));
    }

    async function state(s: Seeded) {
      const l = await raw.orderItem.findUniqueOrThrow({ where: { id: s.lineId } });
      const o = await raw.order.findUniqueOrThrow({ where: { id: s.orderId } });
      return {
        line: {
          qty: Number(l.qty),
          boxes: l.boxes == null ? null : Number(l.boxes),
          pieces: l.pieces == null ? null : Number(l.pieces),
          unitsPerBox: (l as any).unitsPerBox ?? null,
          unitPrice: Number(l.unitPrice),
          subtotal: Number(l.subtotal),
        },
        order: { subtotal: Number(o.subtotal), total: Number(o.total) },
      };
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
        gateway: {
          emitOrderCreated: jest.fn(),
          emitUrgentOrder: jest.fn(),
          emitOrderStatusChanged: jest.fn(),
          emitLowStock: jest.fn(),
        },
        notifications: {
          sendToCustomer: jest.fn().mockResolvedValue(undefined),
          sendToUser: jest.fn().mockResolvedValue(1),
        },
        messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
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
          findOpenOrderDraft: async () => null,
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
          releaseWalletPaymentsInTx: async () => undefined,
          voidInvoiceInTx: async () => undefined,
        },
        creditNotes: {
          settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
          previewOrderCreditRelease: async () => [],
          releaseOrderCreditsInTx: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        oversellReader: { read: async () => false },
      });
      tenantId = (await raw.tenant.create({ data: { slug, name: `A2CR ${slug}` } })).id;
      const buyer = await raw.user.create({
        data: {
          email: `buyer-${run}@example.test`,
          username: `buyer-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      customerId = (
        await raw.customer.create({
          data: { userId: buyer.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
        })
      ).id;
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
      driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
    }, 120_000);

    afterAll(async () => {
      try {
        await raw.changeRequest.deleteMany({ where: { tenantId } });
        await raw.deliveryMutation.deleteMany({ where: { tenantId } });
        const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
          (o) => o.id,
        );
        await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
        await raw.stockMovement.deleteMany({ where: { product: { tenantId } } });
        await raw.orderItem.deleteMany({ where: { tenantId } });
        await raw.order.deleteMany({ where: { tenantId } });
        await raw.routeRunStop.deleteMany({ where: { routeRun: { route: { tenantId } } } });
        await raw.routeRun.deleteMany({ where: { route: { tenantId } } });
        await raw.routeStop.deleteMany({ where: { route: { tenantId } } });
        await raw.route.deleteMany({ where: { tenantId } });
        await raw.auditLog.deleteMany({ where: { tenantId } });
        await raw.driver.deleteMany({ where: { tenantId } });
        await raw.product.deleteMany({ where: { tenantId } });
        await raw.customer.deleteMany({ where: { tenantId } });
        await raw.user.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      } finally {
        await _resetLockPoolForTests();
        await prisma?.$disconnect();
        await raw?.$disconnect();
        await pool?.end();
      }
    }, 120_000);

    it("B-1: a line sold under a 12-pack (now a 24-pack), 120 -> 108, is 9 boxes of 12 at the stored price: 90.00, snapshot 12", async () => {
      const s = await seed({ qty: 120, boxes: 10, pieces: 0, subtotal: 100 });
      await changeQty(s, 108);
      const after = await state(s);
      measure("B-1 after", after);
      expect(after.line).toMatchObject({
        qty: 108,
        boxes: 9,
        pieces: 0,
        unitsPerBox: 12,
        subtotal: 90,
      });
    }, 120_000);

    it("B-2: a line sold with no pack (10 boxes, qty 10), 10 -> 9, is 90.00 at the stored price, not 9 pieces of the live 24 (3.75)", async () => {
      const s = await seed({ qty: 10, boxes: 10, pieces: 0, subtotal: 100 });
      await changeQty(s, 9);
      const after = await state(s);
      measure("B-2 after", after);
      expect(after.line).toMatchObject({ qty: 9, unitsPerBox: null, subtotal: 90 });
    }, 120_000);

    it("B-3: 0 boxes + 6 pieces with no snapshot and a subtotal that fits neither pack (7.00) is refused with the code, nothing written", async () => {
      const s = await seed({ qty: 6, boxes: 0, pieces: 6, subtotal: 7 });
      const before = await state(s);
      let thrown: any = null;
      try {
        await changeQty(s, 5);
      } catch (e) {
        thrown = e;
      }
      const after = await state(s);
      measure("B-3 after", after);
      measure("B-3 thrown", thrown ? (thrown.getResponse?.() ?? String(thrown)) : null);
      expect(thrown?.getResponse?.()).toMatchObject({ code: "STORED_LINE_PACK_UNREADABLE" });
      expect(after).toEqual(before);
    }, 120_000);

    it("B-4 (guard): a line WITH its snapshot (12) resizes at it: 120 -> 108 is 9 boxes, 90.00", async () => {
      const s = await seed({ qty: 120, boxes: 10, pieces: 0, subtotal: 100, snapshot: 12 });
      await changeQty(s, 108);
      const after = await state(s);
      measure("B-4 after", after);
      expect(after.line).toMatchObject({
        qty: 108,
        boxes: 9,
        unitsPerBox: 12,
        subtotal: 90,
      });
    }, 120_000);
  },
);
