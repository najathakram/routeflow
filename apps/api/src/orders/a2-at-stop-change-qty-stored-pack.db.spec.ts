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
      promoFreeUnits?: number;
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
          ...(shape.snapshot !== undefined ? { unitsPerBox: shape.snapshot } : {}),
          deliveredQty: 0,
          ...(shape.promoFreeUnits ? { promoFreeUnits: shape.promoFreeUnits } : {}),
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

    /** Files the CHANGE_QTY as `by` (a driver at the door by default; a buyer's request has requestedByRole CUSTOMER) and approves it. */
    async function changeQty(s: Seeded, newQty: number, by: "DRIVER" | "CUSTOMER" = "DRIVER") {
      const cr = await fileChangeQty(s, newQty, by);
      return tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver()));
    }
    async function fileChangeQty(s: Seeded, newQty: number, by: "DRIVER" | "CUSTOMER" = "DRIVER") {
      return raw.changeRequest.create({
        data: {
          tenantId,
          orderId: s.orderId,
          productId: s.productId,
          orderItemId: s.lineId,
          routeRunStopId: s.stopId,
          type: "CHANGE_QTY" as any,
          requestedByRole: by,
          payload: { orderItemId: s.lineId, newQty },
        } as any,
      });
    }

    async function state(s: Seeded) {
      const l = await raw.orderItem.findUniqueOrThrow({ where: { id: s.lineId } });
      const o = await raw.order.findUniqueOrThrow({ where: { id: s.orderId } });
      const product = await raw.product.findUniqueOrThrow({ where: { id: s.productId } });
      const moves = await raw.stockMovement.findMany({
        where: { productId: s.productId },
        orderBy: { createdAt: "asc" },
      });
      return {
        stock: Number(product.currentStock),
        ledger: moves.map((m) => ({ type: m.type, qty: Number(m.quantity) })),
        line: {
          qty: Number(l.qty),
          boxes: l.boxes == null ? null : Number(l.boxes),
          pieces: l.pieces == null ? null : Number(l.pieces),
          unitsPerBox: (l as any).unitsPerBox ?? null,
          unitPrice: Number(l.unitPrice),
          subtotal: Number(l.subtotal),
          promoFreeUnits: Number((l as any).promoFreeUnits ?? 0),
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

    /** The door edit books the exact delta: qty released goes back to stock, one SALE row of that size, read as pieces. */
    const restocked = (before: any, after: any, units: number) => {
      expect(after.stock - before.stock).toBe(units);
      expect(after.ledger.slice(before.ledger.length)).toEqual(
        units === 0 ? [] : [{ type: "SALE", qty: units }],
      );
    };
    const unmoved = (before: any, after: any) => restocked(before, after, 0);
    const refused = async (s: Seeded, newQty: number) => {
      try {
        await changeQty(s, newQty);
      } catch (e: any) {
        return e?.getResponse?.() ?? String(e);
      }
      return null;
    };

    it("B-1: a line sold under a 12-pack (now a 24-pack), 120 -> 108, is 9 boxes of 12 at the stored price: 90.00, snapshot 12", async () => {
      const s = await seed({ qty: 120, boxes: 10, pieces: 0, subtotal: 100 });
      const before = await state(s);
      await changeQty(s, 108);
      const after = await state(s);
      measure("B-1 after", after);
      restocked(before, after, 12);
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
      const before = await state(s);
      await changeQty(s, 9);
      const after = await state(s);
      measure("B-2 after", after);
      expect(after.line).toMatchObject({
        qty: 9,
        boxes: 9,
        pieces: 0,
        unitsPerBox: null,
        subtotal: 90,
      });
      restocked(before, after, 1);
    }, 120_000);

    it("B-2b (mutant: the at-door snapshot gate): a line stamped 0 or 1 (no pack) is read like an unstamped one - 10 -> 9 is 90.00, not 9 pieces of the live 24", async () => {
      for (const snapshot of [0, 1]) {
        const s = await seed({ qty: 10, boxes: 10, pieces: 0, subtotal: 100, snapshot });
        const before = await state(s);
        await changeQty(s, 9);
        const after = await state(s);
        measure(`B-2b snapshot ${snapshot} after`, after);
        expect(after.line).toMatchObject({ qty: 9, boxes: 9, pieces: 0, subtotal: 90 });
        restocked(before, after, 1);
      }
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
      const before = await state(s);
      await changeQty(s, 108);
      const after = await state(s);
      measure("B-4 after", after);
      restocked(before, after, 12);
      expect(after.line).toMatchObject({
        qty: 108,
        boxes: 9,
        unitsPerBox: 12,
        subtotal: 90,
      });
    }, 120_000);

    it("B-5: a no-pack line (10 boxes, qty 10), CHANGE_QTY 9.5, is refused (whole units only), nothing written", async () => {
      const s = await seed({ qty: 10, boxes: 10, pieces: 0, subtotal: 100 });
      const before = await state(s);
      const thrown = await refused(s, 9.5);
      const after = await state(s);
      measure("B-5 after", after);
      measure("B-5 thrown", thrown);
      expect(thrown).toMatchObject({ code: "INVALID_LINE_SPLIT" });
      expect(after).toEqual(before);
    }, 120_000);

    it("B-5b: a no-pack line, CHANGE_QTY 0.5, is refused, not written as qty 0 / 0.00", async () => {
      const s = await seed({ qty: 10, boxes: 10, pieces: 0, subtotal: 100 });
      const before = await state(s);
      const thrown = await refused(s, 0.5);
      const after = await state(s);
      measure("B-5b after", after);
      measure("B-5b thrown", thrown);
      expect(thrown).toMatchObject({ code: "INVALID_LINE_SPLIT" });
      expect(after).toEqual(before);
    }, 120_000);

    it("B-6 (guard): B-1 filed by a driver and by a buyer gives the same money and stock", async () => {
      const a = await seed({ qty: 120, boxes: 10, pieces: 0, subtotal: 100 });
      const b = await seed({ qty: 120, boxes: 10, pieces: 0, subtotal: 100 });
      const beforeA = await state(a);
      const beforeB = await state(b);
      await changeQty(a, 108, "DRIVER");
      await changeQty(b, 108, "CUSTOMER");
      const afterA = await state(a);
      const afterB = await state(b);
      measure("B-6 driver", afterA);
      measure("B-6 buyer", afterB);
      expect(afterB.line).toEqual(afterA.line);
      expect(afterB.order).toEqual(afterA.order);
      restocked(beforeA, afterA, 12);
      restocked(beforeB, afterB, 12);
    }, 120_000);

    it("B-7 (guard): a no-pack line with 2 free units, 10 -> 9, keeps its shape and the free units rescale on whole units", async () => {
      const s = await seed({ qty: 10, boxes: 10, pieces: 0, subtotal: 80, promoFreeUnits: 2 });
      const before = await state(s);
      await changeQty(s, 9);
      const after = await state(s);
      measure("B-7 before", before);
      measure("B-7 after", after);
      expect(after.line).toMatchObject({ qty: 9, boxes: 9, pieces: 0, unitsPerBox: null });
      expect(Number.isInteger(after.line.promoFreeUnits)).toBe(true);
      expect(after.line.subtotal).toBe((9 - after.line.promoFreeUnits) * 10);
      restocked(before, after, 1);
    }, 120_000);

    it("B-8 (guard): a refused request (B-3) stays PENDING and can still be rejected", async () => {
      const s = await seed({ qty: 6, boxes: 0, pieces: 6, subtotal: 7 });
      const cr = await fileChangeQty(s, 5);
      let thrown: any = null;
      try {
        await tenantCtx.run(tenantId, () => orders.approveChangeRequestAtStop(cr.id, driver()));
      } catch (e) {
        thrown = e;
      }
      const row = await raw.changeRequest.findUniqueOrThrow({ where: { id: cr.id } });
      measure("B-8 status after refusal", row.status);
      expect(thrown?.getResponse?.()).toMatchObject({ code: "STORED_LINE_PACK_UNREADABLE" });
      expect(row.status).toBe("PENDING");
      expect(row.resolvedAt).toBeNull();
    }, 120_000);
  },
);
