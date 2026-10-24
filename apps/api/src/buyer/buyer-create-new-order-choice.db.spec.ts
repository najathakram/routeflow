/**
 * B1239 — "Create new order instead" on the buyer cart must create a NEW order and leave the buyer's
 * pending order exactly as it was. Real Postgres, THROUGH the real BuyerController.createOrder, the real
 * OrdersService create + the real post-create consolidation sweep (mergeAllPendingForCustomer).
 *
 * The web cart already sends `forceNew: true` and the DTO declares it; the controller honoured it for the
 * pre-create fold but then ran the buyer-driven sweep over the new order, which folded it straight back
 * into the pending one (the new order was deleted, its number burned). A duplicate submit of the same cart
 * then found no order holding its Idempotency-Key and applied the cart a second time.
 *
 *  - forceNew + a pending order: a NEW order exists, the pending order is byte-for-byte unchanged;
 *  - the same cart submitted twice (sequentially and concurrently, one Idempotency-Key): exactly ONE new
 *    order, its lines not doubled, the pending order still unchanged;
 *  - the later hourly sweep leaves the buyer's separate order alone;
 *  - FENCE: WITHOUT forceNew the cart still folds into the pending order (under the customer lock).
 *
 * SAFETY: one throwaway `qa-b1239-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly
 * the rows this run created, in FK order.
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
import { BuyerController } from "./buyer.controller";
import { OrdersService } from "../orders/orders.service";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const UNIT_PRICE = 10;

describeDb(
  "B1239 — buyer 'Create new order instead' keeps the pending order, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let controller: any;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-b1239-${run}`, "buyer-create-new-order-choice.db.spec.ts");
    let tenantId = "";
    let buyerUserId = "";
    let customerId = "";
    let productId = "";

    const ctx = () => ({
      customerId,
      tenantId,
      tenantSlug: slug,
      userId: buyerUserId,
      customer: { id: customerId, businessName: `Acme ${run}` },
    });
    const submit = (items: any[], extra: Record<string, unknown> = {}, key?: string) =>
      tenantCtx.run(tenantId, () => controller.createOrder({ items, ...extra }, ctx(), key));
    const orderCount = () => raw.order.count({ where: { tenantId } });
    const snapshot = async (orderId: string) => {
      const o = await raw.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { lineItems: { orderBy: { position: "asc" } } },
      });
      return {
        orderNumber: o.orderNumber,
        status: o.status,
        subtotal: Number(o.subtotal),
        total: Number(o.total),
        lines: o.lineItems.map((l) => ({
          productId: l.productId,
          qty: Number(l.qty),
          unitPrice: Number(l.unitPrice),
          subtotal: Number(l.subtotal),
        })),
      };
    };

    /** The buyer's open, mergeable PENDING order: 2 units at UNIT_PRICE. */
    async function seedPending(): Promise<string> {
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: String(2 * UNIT_PRICE),
          total: String(2 * UNIT_PRICE),
          lineItems: {
            create: [
              {
                tenantId,
                productId,
                qty: 2,
                unitPrice: String(UNIT_PRICE),
                subtotal: String(2 * UNIT_PRICE),
              },
            ],
          },
        },
      });
      return o.id;
    }

    async function wipe() {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({ where: { productId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
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
        featureConfig: { getEffectiveMode: async () => "on" },
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
        },
        creditNotes: {
          validateSelectionsForCustomer: async () => undefined,
          settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        oversellReader: { read: async () => ({ allowOversell: true }) },
      });
      controller = Object.assign(Object.create(BuyerController.prototype), {
        prisma,
        ordersService: orders,
        logger: new Logger("BuyerController"),
      });

      tenantId = (await raw.tenant.create({ data: { slug, name: `B1239 ${slug}` } })).id;
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
          data: { userId: buyerUserId, businessName: `Acme ${run}`, contactName: "T", tenantId },
        })
      ).id;
      productId = (
        await raw.product.create({
          data: {
            name: `Bread ${run}`,
            unit: "Each",
            pricePerUnit: String(UNIT_PRICE),
            currentStock: "100000",
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    beforeEach(async () => {
      await wipe();
    });

    afterAll(async () => {
      try {
        await wipe();
        await raw.auditLog.deleteMany({ where: { tenantId } });
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

    it("forceNew with a pending order: a NEW order exists and the pending order is unchanged", async () => {
      const pendingId = await seedPending();
      const before = await snapshot(pendingId);

      const result = await submit([{ productId, qty: 3 }], { forceNew: true }, `k-${run}-a`);

      expect(result.id).not.toBe(pendingId);
      expect(await orderCount()).toBe(2);
      expect(await snapshot(pendingId)).toEqual(before);
      const created = await snapshot(result.id);
      expect(created.lines).toEqual([
        { productId, qty: 3, unitPrice: UNIT_PRICE, subtotal: 3 * UNIT_PRICE },
      ]);
      expect(created.orderNumber).not.toBe(before.orderNumber);
    }, 120_000);

    it("the same forceNew cart submitted twice (one key) is ONE new order, lines not doubled", async () => {
      const pendingId = await seedPending();
      const before = await snapshot(pendingId);
      const key = `k-${run}-b`;

      const first = await submit([{ productId, qty: 3 }], { forceNew: true }, key);
      const second = await submit([{ productId, qty: 3 }], { forceNew: true }, key);

      expect(second.id).toBe(first.id);
      expect(await orderCount()).toBe(2);
      expect((await snapshot(first.id)).lines).toEqual([
        { productId, qty: 3, unitPrice: UNIT_PRICE, subtotal: 3 * UNIT_PRICE },
      ]);
      expect(await snapshot(pendingId)).toEqual(before);
    }, 120_000);

    it("two CONCURRENT forceNew submits of one cart (one key) are ONE new order", async () => {
      const pendingId = await seedPending();
      const before = await snapshot(pendingId);
      const key = `k-${run}-c`;

      const settled = await Promise.allSettled([
        submit([{ productId, qty: 3 }], { forceNew: true }, key),
        submit([{ productId, qty: 3 }], { forceNew: true }, key),
      ]);

      for (const s of settled) expect(s.status).toBe("fulfilled");
      const ids = settled.map((s) => (s as PromiseFulfilledResult<{ id: string }>).value.id);
      expect(ids[0]).toBe(ids[1]);
      expect(await orderCount()).toBe(2);
      expect((await snapshot(ids[0])).lines).toEqual([
        { productId, qty: 3, unitPrice: UNIT_PRICE, subtotal: 3 * UNIT_PRICE },
      ]);
      expect(await snapshot(pendingId)).toEqual(before);
    }, 120_000);

    it("the hourly consolidation sweep leaves the buyer's separate order alone", async () => {
      const pendingId = await seedPending();
      const before = await snapshot(pendingId);
      const result = await submit([{ productId, qty: 3 }], { forceNew: true }, `k-${run}-d`);

      await tenantCtx.run(tenantId, () => orders.mergeAllPendingForCustomer(customerId));

      expect(await orderCount()).toBe(2);
      expect(await snapshot(pendingId)).toEqual(before);
      expect((await snapshot(result.id)).lines[0].qty).toBe(3);
    }, 120_000);

    it("FENCE: WITHOUT forceNew the cart still folds into the pending order", async () => {
      const pendingId = await seedPending();

      const result = await submit([{ productId, qty: 3 }], {}, `k-${run}-e`);

      expect(result.id).toBe(pendingId);
      expect(await orderCount()).toBe(1);
      const merged = await snapshot(pendingId);
      expect(merged.lines).toEqual([
        { productId, qty: 5, unitPrice: UNIT_PRICE, subtotal: 5 * UNIT_PRICE },
      ]);
    }, 120_000);
  },
);
